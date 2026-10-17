package dev.mct.bridge;

import com.google.gson.*;
import com.sun.net.httpserver.*;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

/** Local authenticated companion. Game operations run only from actual tick/render hooks. */
public final class BridgeMod implements ClientModInitializer {
    public static volatile BridgeMod instance;
    static final Gson JSON = new GsonBuilder().serializeNulls().create();
    private final Queue<Request> calls = new ConcurrentLinkedQueue<>(), captures = new ConcurrentLinkedQueue<>();
    private final Map<String, Held> held = new HashMap<>();
    private final String token = UUID.randomUUID().toString() + UUID.randomUUID();
    private final String startedAt = Instant.now().toString();
    private volatile Map<String, Object> latest = Map.of("ready", false);
    private volatile Object client;
    private GameApi api;
    private HttpServer http;
    private Path discovery;
    private long tick, frame;
    private final String version = FabricLoader.getInstance().getModContainer("minecraft").orElseThrow().getMetadata().getVersion().getFriendlyString();
    record Request(String action, JsonObject args, CompletableFuture<Object> result, long expires) { }
    record Held(Object key, long until) { }

    @Override public void onInitializeClient() {
        try {
            api = new GameApi(); instance = this;
            http = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), Integer.getInteger("mct.port", 0)), 16);
            http.createContext("/status", exchange -> handle(exchange, false));
            http.createContext("/call", exchange -> handle(exchange, true));
            http.setExecutor(Executors.newFixedThreadPool(4, runnable -> { Thread t = new Thread(runnable, "mct-http"); t.setDaemon(true); return t; }));
            // HttpServer's dispatcher inherits daemon state from its starting thread.
            Thread starter = new Thread(http::start, "mct-http-start"); starter.setDaemon(true); starter.start(); starter.join();
            Path directory = Path.of(System.getProperty("mct.discoveryDir", FabricLoader.getInstance().getGameDir().resolve(".mct").toString()));
            Files.createDirectories(directory);
            try { Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------")); } catch (UnsupportedOperationException ignored) { }
            discovery = directory.resolve("fabric-" + ProcessHandle.current().pid() + ".json");
            Files.writeString(discovery, JSON.toJson(Map.of("kind", "fabric", "protocol", 1, "port", http.getAddress().getPort(), "token", token, "pid", ProcessHandle.current().pid(), "gameVersion", version, "startedAt", startedAt)), StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            try { Files.setPosixFilePermissions(discovery, PosixFilePermissions.fromString("rw-------")); } catch (UnsupportedOperationException ignored) { }
            Runtime.getRuntime().addShutdownHook(new Thread(this::shutdown, "mct-close"));
            System.out.println("[mct] Companion discovery: " + discovery);
        } catch (Exception error) { throw new IllegalStateException("MCT companion initialization failed", error); }
    }
    private void handle(HttpExchange exchange, boolean call) throws IOException {
        int status = 200; Object response;
        try {
            if (!MessageDigest.isEqual(("Bearer " + token).getBytes(StandardCharsets.UTF_8), Objects.toString(exchange.getRequestHeaders().getFirst("Authorization"), "").getBytes(StandardCharsets.UTF_8))) { send(exchange, 401, Map.of("error", Map.of("code", "UNAUTHORIZED", "message", "Bearer token required"))); return; }
            if (!exchange.getRequestURI().getPath().equals(call ? "/call" : "/status")) { send(exchange, 404, Map.of("error", "NOT_FOUND")); return; }
            if (!exchange.getRequestMethod().equals(call ? "POST" : "GET")) { send(exchange, 405, Map.of("error", "METHOD_NOT_ALLOWED")); return; }
            if (!call) response = status();
            else {
                byte[] bytes = exchange.getRequestBody().readNBytes(1_048_577);
                if (bytes.length > 1_048_576) throw new IllegalArgumentException("Request exceeds 1 MiB");
                JsonObject request = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
                String action = request.get("action").getAsString();
                JsonObject args = request.has("args") ? request.getAsJsonObject("args") : new JsonObject();
                Request pending = new Request(action, args, new CompletableFuture<>(), System.nanoTime() + TimeUnit.SECONDS.toNanos(10));
                (action.equals("capture") ? captures : calls).add(pending);
                try { response = pending.result.get(12, TimeUnit.SECONDS); }
                catch (Exception error) { pending.result.cancel(false); calls.remove(pending); captures.remove(pending); throw error; }
            }
        } catch (Exception error) {
            Throwable cause = error instanceof ExecutionException && error.getCause() != null ? error.getCause() : error;
            status = cause instanceof IllegalArgumentException ? 400 : cause instanceof TimeoutException ? 504 : 422;
            response = Map.of("error", Map.of("code", cause instanceof NoSuchMethodException || cause instanceof NoSuchFieldException ? "CAPABILITY_UNAVAILABLE" : status == 504 ? "GAME_THREAD_TIMEOUT" : "ACTION_FAILED", "message", Objects.toString(cause.getMessage(), cause.toString()), "gameVersion", version));
        }
        send(exchange, status, response);
    }
    private static void send(HttpExchange exchange, int code, Object response) throws IOException {
        byte[] bytes = JSON.toJson(response).getBytes(StandardCharsets.UTF_8); exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8"); exchange.getResponseHeaders().set("Cache-Control", "no-store"); exchange.sendResponseHeaders(code, bytes.length); try (OutputStream output = exchange.getResponseBody()) { output.write(bytes); }
    }
    private Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>(latest); out.put("kind", "fabric"); out.put("protocol", 1); out.put("gameVersion", version); out.put("startedAt", startedAt); out.put("runtimeVerified", false); return out;
    }
    public static void onTick(Object client) { BridgeMod bridge = instance; if (bridge != null) bridge.tick(client); }
    public static void onFrame(Object client) { BridgeMod bridge = instance; if (bridge != null) bridge.frame(client); }
    public static void onClose() { BridgeMod bridge = instance; if (bridge != null) bridge.shutdown(); }
    private void shutdown() {
        release();
        if (http != null) http.stop(0);
        for (Request request : calls) request.result.completeExceptionally(new IllegalStateException("Game client closed"));
        for (Request request : captures) request.result.completeExceptionally(new IllegalStateException("Game client closed"));
        calls.clear(); captures.clear();
        try { if (discovery != null) Files.deleteIfExists(discovery); } catch (IOException ignored) { }
    }
    private void tick(Object client) {
        this.client = client; tick++;
        try {
            if (api.optionalField(client, "player") == null) release();
            for (Iterator<Map.Entry<String, Held>> iterator = held.entrySet().iterator(); iterator.hasNext();) {
                Held value = iterator.next().getValue(); if (System.nanoTime() >= value.until) { api.call(value.key, "setPressed|setDown", false); iterator.remove(); }
            }
            Request request; int budget = 32;
            while (budget-- > 0 && (request = calls.poll()) != null) {
                if (request.result.isDone() || System.nanoTime() > request.expires) { request.result.completeExceptionally(new TimeoutException("Action expired before game execution")); continue; }
                try { request.result.complete(action(request.action, request.args)); } catch (Exception error) { release(); request.result.completeExceptionally(error); }
            }
            latest = observe();
        } catch (Exception error) { latest = new LinkedHashMap<>(Map.of("ready", false, "gameVersion", version, "error", Objects.toString(error.getMessage(), error.toString()), "tick", tick, "frame", frame)); }
    }
    private void frame(Object client) {
        this.client = client; frame++;
        Request request = captures.poll(); if (request == null) return;
        if (request.result.isDone() || System.nanoTime() > request.expires) { request.result.completeExceptionally(new TimeoutException("Capture expired before render")); return; }
        final Request capture = request;
        try {
            final Map<String, Object> capturedTelemetry = observe();
            final long capturedFrame = frame;
            Object target = api.optionalCall(client, "getFramebuffer|getMainRenderTarget");
            if (target == null) target = api.call(api.field(client, "gameRenderer"), "mainRenderTarget");
            Class<?> recorder = api.type("ScreenshotRecorder|net.minecraft.client.Screenshot");
            Consumer<Object> done = image -> {
                try {
                    byte[] bytes;
                    try { bytes = (byte[]) api.call(image, "getBytes|asByteArray"); }
                    catch (NoSuchMethodException modern) {
                        Path temporary = Files.createTempFile(discovery.getParent(), "capture-", ".png");
                        try { api.call(image, "writeTo|writeToFile", temporary); bytes = Files.readAllBytes(temporary); }
                        finally { Files.deleteIfExists(temporary); }
                    }
                    Map<String, Object> out = new LinkedHashMap<>(capturedTelemetry);
                    out.put("mimeType", "image/png"); out.put("base64", Base64.getEncoder().encodeToString(bytes)); out.put("source", "fabric-game-framebuffer"); out.put("includesHud", true); out.put("captureFrame", capturedFrame); out.put("readbackCompletedAt", Instant.now().toString()); out.put("width", api.optionalCall(image, "getWidth")); out.put("height", api.optionalCall(image, "getHeight")); capture.result.complete(out);
                } catch (Exception error) { capture.result.completeExceptionally(error); }
                finally { api.optionalCall(image, "close"); }
            };
            try { api.call(recorder, "takeScreenshot", target, done); }
            catch (NoSuchMethodException older) { done.accept(api.call(recorder, "takeScreenshot", target)); }
        } catch (Exception error) { capture.result.completeExceptionally(error); }
    }
    private Map<String, Object> observe() throws Exception {
        Map<String, Object> out = new LinkedHashMap<>(); Object overlay = api.optionalCall(client, "getOverlay"); Object gui = api.optionalField(client, "gui"); if (overlay == null && gui != null) overlay = api.optionalCall(gui, "overlay"); Object finished = api.optionalCall(client, "isFinishedLoading|isGameLoadFinished"); boolean loading = overlay != null || Boolean.FALSE.equals(finished); out.put("ready", !loading); out.put("loading", loading); out.put("overlay", overlay == null ? null : overlay.getClass().getName()); out.put("gameVersion", version); out.put("observedAt", Instant.now().toString()); out.put("tick", tick); out.put("frame", frame); out.put("source", "fabric-client");
        Object player = api.optionalField(client, "player"); out.put("connected", player != null);
        Object screen = screen();
        if (screen == null) out.put("screen", null);
        else { Map<String, Object> info = new LinkedHashMap<>(); info.put("class", screen.getClass().getName()); info.put("title", text(api.optionalCall(screen, "getTitle"))); info.put("width", api.optionalField(screen, "width")); info.put("height", api.optionalField(screen, "height")); out.put("screen", info); }
        if (player != null) {
            Map<String, Object> position = new LinkedHashMap<>();
            position.put("x", api.call(player, "getX")); position.put("y", api.call(player, "getY")); position.put("z", api.call(player, "getZ")); position.put("yaw", api.call(player, "getYaw|getYRot")); position.put("pitch", api.call(player, "getPitch|getXRot")); position.put("health", api.optionalCall(player, "getHealth")); position.put("name", text(api.optionalCall(player, "getName")));
            Object world = api.optionalField(client, "world|level"); Object dimension = world == null ? null : api.optionalCall(world, "getRegistryKey|dimension"); out.put("dimension", dimension == null ? null : text(api.optionalCall(dimension, "getValue|identifier|location")));
            out.put("player", position); out.put("inventory", inventory(player));
        } else out.put("player", null);
        return out;
    }
    private Object screen() throws Exception { Object screen = api.optionalField(client, "currentScreen|screen"); if (screen == null) { Object gui = api.optionalField(client, "gui"); if (gui != null) screen = api.optionalCall(gui, "screen"); } return screen; }
    private void setScreen(Object screen) throws Exception { try { api.call(client, "setScreen", screen); } catch (NoSuchMethodException newer) { api.call(api.field(client, "gui"), "setScreen", screen); } }
    private String text(Object object) { if (object == null) return ""; Object string = api.optionalCall(object, "getString"); return string == null ? object.toString() : string.toString(); }
    private Object inventory(Object player) throws Exception {
        Object menu = api.field(player, "currentScreenHandler|containerMenu");
        Object slots = api.field(menu, "slots"); List<Object> items = new ArrayList<>(); int index = 0;
        for (Object slot : (Iterable<?>) slots) {
            Object stack = api.call(slot, "getStack|getItem"); Object empty = api.optionalCall(stack, "isEmpty");
            Map<String, Object> item = new LinkedHashMap<>(); item.put("slot", index++); item.put("empty", empty); item.put("count", api.call(stack, "getCount")); item.put("name", text(api.optionalCall(stack, "getName|getHoverName"))); item.put("item", text(api.optionalCall(stack, "getItem"))); items.add(item);
        }
        return Map.of("syncId", api.field(menu, "syncId|containerId"), "slots", items);
    }
    private Object action(String action, JsonObject args) throws Exception {
        switch (action) {
            case "observe": return observe();
            case "stop": release(); return observe();
            case "look": {
                Object player = player(); double yaw = number(args, "yaw", 0), pitch = number(args, "pitch", 0); if (pitch < -90 || pitch > 90) throw new IllegalArgumentException("pitch must be -90..90 degrees");
                api.call(player, "setYaw|setYRot", yaw); api.call(player, "setPitch|setXRot", pitch); return observe();
            }
            case "input": {
                String key = string(args, "key", ""), mode = string(args, "action", "press");
                if (key.equals("inventory") && mode.equals("press")) { setScreen(api.create("InventoryScreen|net.minecraft.client.gui.screens.inventory.InventoryScreen", player())); return observe(); }
                if (key.equals("escape") && mode.equals("press")) { Object screen = screen(); if (screen != null) api.call(screen, "close|onClose"); return observe(); }
                Map<String, String> keys = Map.ofEntries(Map.entry("forward", "forwardKey|keyUp"), Map.entry("back", "backKey|keyDown"), Map.entry("left", "leftKey|keyLeft"), Map.entry("right", "rightKey|keyRight"), Map.entry("jump", "jumpKey|keyJump"), Map.entry("sneak", "sneakKey|keyShift"), Map.entry("sprint", "sprintKey|keySprint"), Map.entry("attack", "attackKey|keyAttack"), Map.entry("use", "useKey|keyUse"), Map.entry("drop", "dropKey|keyDrop"), Map.entry("chat", "chatKey|keyChat"), Map.entry("command", "commandKey|keyCommand"));
                if (!keys.containsKey(key)) throw new IllegalArgumentException("Unknown semantic key: " + key);
                if (!mode.equals("press") && !mode.equals("release")) throw new IllegalArgumentException("action must be press or release");
                Object binding = api.field(api.field(client, "options"), keys.get(key)); boolean press = mode.equals("press");
                if (press) { player(); long duration = (long) number(args, "durationMs", 200); if (duration < 1 || duration > 5000) throw new IllegalArgumentException("durationMs must be 1..5000"); held.put(key, new Held(binding, System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(duration))); }
                else held.remove(key);
                api.call(binding, "setPressed|setDown", press);
                if (press && Set.of("attack", "use", "drop", "chat", "command").contains(key)) { Object count = api.field(binding, "timesPressed|clickCount"); api.set(binding, "timesPressed|clickCount", ((Number) count).intValue() + 1); }
                return observe();
            }
            case "inventory": {
                Object player = player(); if (!args.has("slot")) return inventory(player);
                Object menu = api.field(player, "currentScreenHandler|containerMenu"); int slot = (int) number(args, "slot", -1); int size = ((Collection<?>) api.field(menu, "slots")).size(); if (slot < 0 || slot >= size) throw new IllegalArgumentException("Invalid slot index");
                int button = (int) number(args, "button", 0); if (button < 0 || button > 1) throw new IllegalArgumentException("button must be 0 or 1");
                String mode = string(args, "mode", "PICKUP"); if (!Set.of("PICKUP", "QUICK_MOVE", "THROW").contains(mode)) throw new IllegalArgumentException("mode must be PICKUP, QUICK_MOVE or THROW");
                Class<?> kind = api.type("SlotActionType|net.minecraft.world.inventory.ClickType|net.minecraft.world.inventory.ContainerInput"); Object enumValue = api.field(kind, mode);
                api.call(api.field(client, "interactionManager|gameMode"), "clickSlot|handleInventoryMouseClick|handleContainerInput", api.field(menu, "syncId|containerId"), slot, button, enumValue, player); return inventory(player);
            }
            case "gui": return gui(args);
            case "blocks": return blocks(args);
            case "command": case "chat": {
                String value = string(args, "text", string(args, "command", string(args, "message", ""))); if (value.isBlank() || value.length() > 256 || value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0) throw new IllegalArgumentException("text must contain 1..256 characters on one line");
                Object connection = api.call(client, "getNetworkHandler|getConnection"); if (connection == null) throw new IllegalStateException("No connected player");
                api.call(connection, action.equals("command") ? "sendChatCommand|sendCommand" : "sendChatMessage|sendChat", action.equals("command") && value.startsWith("/") ? value.substring(1) : value); return Map.of("sent", true, "kind", action);
            }
            case "disconnect": {
                release(); try { api.call(client, "disconnectWithSavingScreen"); } catch (NoSuchMethodException older) { try { api.call(client, "disconnect"); } catch (NoSuchMethodException e) { api.call(client, "disconnect", api.create("TitleScreen|net.minecraft.client.gui.screens.TitleScreen")); } } setScreen(api.create("TitleScreen|net.minecraft.client.gui.screens.TitleScreen")); return Map.of("disconnected", true);
            }
            case "connect": return connect(args);
            default: throw new IllegalArgumentException("Unknown action: " + action);
        }
    }
    private Object gui(JsonObject args) throws Exception {
        Object screen = screen(); if (screen == null) throw new IllegalStateException("No open GUI screen");
        String type = string(args, "type", ""); int modifiers = (int) number(args, "modifiers", 0); Object handled;
        switch (type) {
            case "click": {
                double x = number(args, "x", 0), y = number(args, "y", 0); int button = (int) number(args, "button", 0); if (button < 0 || button > 2) throw new IllegalArgumentException("button must be 0..2");
                Class<?> constants = api.type("InputUtil|com.mojang.blaze3d.platform.InputConstants");
                String buttonName = switch (button) { case 0 -> "GLFW_MOUSE_BUTTON_LEFT|MOUSE_BUTTON_LEFT"; case 1 -> "GLFW_MOUSE_BUTTON_RIGHT|MOUSE_BUTTON_RIGHT"; default -> "GLFW_MOUSE_BUTTON_MIDDLE|MOUSE_BUTTON_MIDDLE"; };
                int nativeButton = ((Number)api.field(constants, buttonName)).intValue();
                try { handled = api.call(screen, "mouseClicked", x, y, nativeButton); api.call(screen, "mouseReleased", x, y, nativeButton); }
                catch (NoSuchMethodException modern) {
                    Object info = api.create("MouseInput|net.minecraft.client.input.MouseButtonInfo", nativeButton, modifiers);
                    Object click = api.create("net.minecraft.client.gui.Click|net.minecraft.client.input.MouseButtonEvent", x, y, info);
                    handled = api.call(screen, "mouseClicked", click, false); api.call(screen, "mouseReleased", click);
                }
                break;
            }
            case "scroll": {
                double x = number(args, "x", 0), y = number(args, "y", 0), horizontal = number(args, "horizontal", 0), vertical = number(args, "vertical", 0);
                try { handled = api.call(screen, "mouseScrolled", x, y, horizontal, vertical); }
                catch (NoSuchMethodException older) { if (horizontal != 0) throw new NoSuchMethodException("Horizontal scroll unavailable in this game version"); handled = api.call(screen, "mouseScrolled", x, y, vertical); }
                break;
            }
            case "text": {
                String value = string(args, "text", ""); if (value.length() > 4096) throw new IllegalArgumentException("GUI text is limited to 4096 UTF-16 units"); int consumed = 0;
                for (int codepoint : value.codePoints().toArray()) {
                    Object result;
                    try { Object event; try { event = api.create("CharInput|net.minecraft.client.input.CharacterEvent", codepoint, modifiers); } catch (NoSuchMethodException newest) { event = api.create("CharInput|net.minecraft.client.input.CharacterEvent", codepoint); } result = api.call(screen, "charTyped", event); }
                    catch (NoSuchMethodException older) { boolean accepted = false; for (char unit : Character.toChars(codepoint)) accepted |= Boolean.TRUE.equals(api.call(screen, "charTyped", unit, modifiers)); result = accepted; }
                    if (Boolean.TRUE.equals(result)) consumed++;
                }
                return Map.of("codepoints", value.codePointCount(0, value.length()), "accepted", consumed);
            }
            case "key": {
                int key = (int) number(args, "key", 0), scanCode = (int) number(args, "scanCode", 0);
                if (args.has("keyName")) {
                    Map<String, String> semantic = Map.of("enter", "GLFW_KEY_ENTER|KEY_RETURN", "escape", "GLFW_KEY_ESCAPE|KEY_ESCAPE", "tab", "GLFW_KEY_TAB|KEY_TAB", "backspace", "GLFW_KEY_BACKSPACE|KEY_BACKSPACE", "delete", "GLFW_KEY_DELETE|KEY_DELETE", "left", "GLFW_KEY_LEFT|KEY_LEFT", "right", "GLFW_KEY_RIGHT|KEY_RIGHT", "up", "GLFW_KEY_UP|KEY_UP", "down", "GLFW_KEY_DOWN|KEY_DOWN");
                    String keyName = string(args, "keyName", ""); if (!semantic.containsKey(keyName)) throw new IllegalArgumentException("Unknown GUI keyName"); key = ((Number) api.field(api.type("InputUtil|com.mojang.blaze3d.platform.InputConstants"), semantic.get(keyName))).intValue();
                    if (version.startsWith("26.")) { String suffix = keyName.equals("enter") ? "RETURN" : keyName.toUpperCase(Locale.ROOT); Object code = api.optionalField(api.type("InputUtil|com.mojang.blaze3d.platform.InputConstants"), "KEYCODE_" + suffix); if (code instanceof Number number) scanCode = number.intValue(); }
                }
                try { handled = api.call(screen, "keyPressed", key, scanCode, modifiers); api.call(screen, "keyReleased", key, scanCode, modifiers); }
                catch (NoSuchMethodException modern) { Object event = api.create("KeyInput|net.minecraft.client.input.KeyEvent", key, scanCode, modifiers); handled = api.call(screen, "keyPressed", event); api.call(screen, "keyReleased", event); }
                break;
            }
            default: throw new IllegalArgumentException("GUI type must be click, scroll, text or key");
        }
        return Map.of("handled", Boolean.TRUE.equals(handled));
    }
    private Object blocks(JsonObject args) throws Exception {
        player(); Object world = api.field(client, "world|level"); JsonObject min = args.getAsJsonObject("min"), max = args.getAsJsonObject("max");
        if (min == null || max == null) throw new IllegalArgumentException("min and max coordinate objects are required");
        int x0 = coordinate(min, "x"), y0 = coordinate(min, "y"), z0 = coordinate(min, "z"), x1 = coordinate(max, "x"), y1 = coordinate(max, "y"), z1 = coordinate(max, "z");
        long width = (long)x1-x0+1, height = (long)y1-y0+1, depth = (long)z1-z0+1;
        if (width < 1 || height < 1 || depth < 1 || width > 4096 || height > 4096 || depth > 4096 || width*height*depth > 4096) throw new IllegalArgumentException("Ordered inclusive bounds must contain at most 4096 blocks");
        Object manager = api.call(world, "getChunkManager|getChunkSource");
        Object full = api.field(api.type("ChunkStatus|net.minecraft.world.level.chunk.status.ChunkStatus"), "FULL");
        Map<Long, Boolean> loadedChunks = new HashMap<>();
        List<Object> values = new ArrayList<>();
        for (int x=x0; x<=x1; x++) for (int y=y0; y<=y1; y++) for (int z=z0; z<=z1; z++) {
            Object pos = api.create("BlockPos|net.minecraft.core.BlockPos", x, y, z); Map<String, Object> value = new LinkedHashMap<>(); value.put("position", Map.of("x", x, "y", y, "z", z));
            // ClientLevel.hasChunk/isLoaded may report true for an empty fallback chunk.
            // The explicit create=false query is the only evidence used here.
            long chunkKey = ((long)(x >> 4) << 32) ^ ((z >> 4) & 0xffffffffL);
            Boolean loaded = loadedChunks.get(chunkKey);
            if (loaded == null) { loaded = api.call(manager, "getChunk", x >> 4, z >> 4, full, false) != null; loadedChunks.put(chunkKey, loaded); }
            if (!loaded) { value.put("known", false); value.put("reason", "chunk-not-loaded"); values.add(value); continue; }
            Object state = api.call(world, "getBlockState", pos); String serialized = state.toString(); value.put("known", true); value.put("state", serialized); value.put("air", api.call(state, "isAir"));
            java.util.regex.Matcher identifier = java.util.regex.Pattern.compile("[a-z0-9_.-]+:[a-z0-9_/.-]+").matcher(serialized); value.put("name", identifier.find() ? identifier.group() : "unknown");
            Map<String, String> properties = new LinkedHashMap<>(); int bracket = serialized.indexOf('['); if (bracket >= 0 && serialized.endsWith("]")) for (String pair : serialized.substring(bracket+1, serialized.length()-1).split(",")) { String[] pieces = pair.split("=", 2); if (pieces.length == 2) properties.put(pieces[0], pieces[1]); } value.put("properties", properties);
            Object shape = api.call(state, "getCollisionShape", world, pos); List<Object> boxes = new ArrayList<>();
            for (Object box : (Iterable<?>) api.call(shape, "getBoundingBoxes|toAabbs")) { List<Object> dimensions = new ArrayList<>(); for (String key : List.of("minX", "minY", "minZ", "maxX", "maxY", "maxZ")) dimensions.add(api.field(box, key)); boxes.add(dimensions); }
            value.put("shapes", boxes); values.add(value);
        }
        Map<String, Object> out = new LinkedHashMap<>(); out.put("blocks", values); out.put("bounds", Map.of("min", min, "max", max)); out.put("source", "fabric-live-world"); out.put("tick", tick); out.put("gameVersion", version); out.put("version", version); out.put("observedAt", Instant.now().toString()); Object dimension = api.optionalCall(world, "getRegistryKey|dimension"); out.put("dimension", dimension == null ? null : text(api.optionalCall(dimension, "getValue|identifier|location"))); return out;
    }
    private Object connect(JsonObject args) throws Exception {
        if (!Boolean.TRUE.equals(observe().get("ready"))) throw new IllegalStateException("Client resources are still loading; wait for observe.ready=true before connecting");
        release(); if (api.optionalField(client, "player") != null) throw new IllegalStateException("Disconnect before connecting to another server");
        String host = string(args, "host", "localhost"); int port = (int) number(args, "port", 25565); if (port < 1 || port > 65535 || host.isBlank()) throw new IllegalArgumentException("Invalid server address");
        String address = host.contains(":") ? "[" + host + "]:" + port : host + ":" + port;
        Object serverAddress = api.call(api.type("ServerAddress|net.minecraft.client.multiplayer.resolver.ServerAddress"), "parse|parseString", address);
        Object serverInfo;
        try { serverInfo = api.create("ServerInfo|net.minecraft.client.multiplayer.ServerData", "MCT", address, false); }
        catch (NoSuchMethodException modern) { Class<?> serverType = api.type("ServerInfo$ServerType|net.minecraft.client.multiplayer.ServerData$Type"); serverInfo = api.create("ServerInfo|net.minecraft.client.multiplayer.ServerData", "MCT", address, api.field(serverType, "OTHER")); }
        Object parent = api.create("TitleScreen|net.minecraft.client.gui.screens.TitleScreen"); Class<?> screen = api.type("ConnectScreen|net.minecraft.client.gui.screens.ConnectScreen");
        try { api.call(screen, "connect|startConnecting", parent, client, serverAddress, serverInfo, false, null); }
        catch (NoSuchMethodException prior) { try { api.call(screen, "connect|startConnecting", parent, client, serverAddress, serverInfo, false); } catch (NoSuchMethodException old) { api.call(screen, "connect|startConnecting", parent, client, serverAddress, serverInfo); } }
        return Map.of("connecting", address);
    }
    private Object player() throws Exception { Object player = api.field(client, "player"); if (player == null) throw new IllegalStateException("No connected player"); return player; }
    private void release() { if (api != null) for (Held value : held.values()) api.optionalCall(value.key, "setPressed|setDown", false); held.clear(); }
    private static String string(JsonObject args, String key, String fallback) { return args.has(key) ? args.get(key).getAsString() : fallback; }
    private static double number(JsonObject args, String key, double fallback) { double value = args.has(key) ? args.get(key).getAsDouble() : fallback; if (!Double.isFinite(value)) throw new IllegalArgumentException(key + " must be finite"); return value; }
    private static int coordinate(JsonObject args, String key) { if (!args.has(key)) throw new IllegalArgumentException("Missing coordinate: " + key); double value = number(args, key, 0); if (value != Math.rint(value) || Math.abs(value) > 30000000) throw new IllegalArgumentException("Coordinates must be integers within world bounds"); return (int)value; }
}
