package dev.mct.bridge;

import com.google.gson.*;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.loader.api.MappingResolver;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Runtime reflection with exact-version intermediary descriptors, never Yarn strings in production. */
public final class GameApi {
    private final MappingResolver resolver = FabricLoader.getInstance().getMappingResolver();
    private final Map<String, JsonObject> byRuntime = new HashMap<>();
    private final Map<String, Class<?>> byName = new HashMap<>();
    private final Map<String, Field> fields = new HashMap<>();
    private final Map<String, Method> methods = new HashMap<>();
    public GameApi() throws Exception {
        try (InputStream in = getClass().getResourceAsStream("/mct-api.json")) {
            JsonArray classes = JsonParser.parseReader(new InputStreamReader(Objects.requireNonNull(in), StandardCharsets.UTF_8)).getAsJsonArray();
            for (JsonElement element : classes) {
                JsonObject entry = element.getAsJsonObject();
                String intermediary = entry.get("intermediary").getAsString().replace('/', '.');
                String runtime = resolver.mapClassName("intermediary", intermediary);
                byRuntime.put(runtime, entry);
            }
        }
    }
    public Class<?> type(String aliases) throws Exception {
        for (String alias : aliases.split("\\|")) {
            if (byName.containsKey(alias)) return byName.get(alias);
            for (Map.Entry<String, JsonObject> candidate : byRuntime.entrySet()) {
                String named = candidate.getValue().get("name").getAsString();
                if (named.equals(alias.replace('.', '/')) || named.endsWith("/" + alias)) {
                    Class<?> found = Class.forName(candidate.getKey()); byName.put(alias, found); return found;
                }
            }
            try { Class<?> found = Class.forName(alias); byName.put(alias, found); return found; }
            catch (ClassNotFoundException ignored) { }
        }
        throw new NoSuchMethodException("Unavailable game class: " + aliases);
    }
    private Set<String> names(Class<?> owner, String kind, String alias) {
        Set<String> result = new LinkedHashSet<>(); result.add(alias);
        JsonObject entry = byRuntime.get(owner.getName());
        if (entry == null || !entry.has(kind)) return result;
        JsonArray members = entry.getAsJsonArray(kind);
        for (JsonElement element : members) {
            JsonObject member = element.getAsJsonObject();
            if (!member.get("name").getAsString().equals(alias)) continue;
            String intermediary = entry.get("intermediary").getAsString().replace('/', '.');
            String n = member.get("intermediary").getAsString(), d = member.get("descriptor").getAsString();
            result.add(kind.equals("methods") ? resolver.mapMethodName("intermediary", intermediary, n, d)
                : resolver.mapFieldName("intermediary", intermediary, n, d));
        }
        return result;
    }
    public Object field(Object target, String aliases) throws Exception {
        Class<?> initial = target instanceof Class<?> c ? c : target.getClass();
        String cacheKey=initial.getName()+":"+aliases; Field cached=fields.get(cacheKey);
        if(cached!=null)return cached.get(target instanceof Class<?> ? null : target);
        for (String alias : aliases.split("\\|")) for (Class<?> c : hierarchy(initial)) {
            for (String name : names(c, "fields", alias)) try {
                Field field = c.getDeclaredField(name); field.setAccessible(true); fields.put(cacheKey,field); return field.get(target instanceof Class<?> ? null : target);
            } catch (NoSuchFieldException ignored) { }
        }
        throw new NoSuchFieldException(initial.getName() + ": " + aliases);
    }
    public void set(Object target, String aliases, Object value) throws Exception {
        Class<?> initial = target instanceof Class<?> c ? c : target.getClass();
        String cacheKey=initial.getName()+":"+aliases; Field cached=fields.get(cacheKey);
        if(cached!=null){cached.set(target instanceof Class<?> ? null : target,convert(cached.getType(),value));return;}
        for (String alias : aliases.split("\\|")) for (Class<?> c : hierarchy(initial)) {
            for (String name : names(c, "fields", alias)) try {
                Field field = c.getDeclaredField(name); field.setAccessible(true); fields.put(cacheKey,field); field.set(target instanceof Class<?> ? null : target, convert(field.getType(), value)); return;
            } catch (NoSuchFieldException ignored) { }
        }
        throw new NoSuchFieldException(initial.getName() + ": " + aliases);
    }
    public Object call(Object target, String aliases, Object... args) throws Exception {
        Class<?> initial = target instanceof Class<?> c ? c : target.getClass();
        StringBuilder cacheKey=new StringBuilder(initial.getName()).append(':').append(aliases);for(Object arg:args)cacheKey.append(':').append(arg==null?"null":arg.getClass().getName());
        Method cached=methods.get(cacheKey.toString()); if(cached!=null)return invoke(cached,target,args);
        for (String alias : aliases.split("\\|")) for (Class<?> c : hierarchy(initial)) {
            Set<String> candidateNames = names(c, "methods", alias);
            for (Method method : c.getDeclaredMethods()) {
                if (!candidateNames.contains(method.getName()) || !matches(method.getParameterTypes(), args)) continue;
                method.setAccessible(true);
                methods.put(cacheKey.toString(),method); return invoke(method,target,args);
            }
        }
        throw new NoSuchMethodException(initial.getName() + ": " + aliases + "/" + args.length);
    }
    private Object invoke(Method method,Object target,Object[] args)throws Exception{try{return method.invoke(target instanceof Class<?> ? null : target,converted(method.getParameterTypes(),args));}catch(InvocationTargetException error){if(error.getCause() instanceof Exception e)throw e;throw error;}}
    public boolean named(Method method,String aliases){for(String alias:aliases.split("\\|"))if(names(method.getDeclaringClass(),"methods",alias).contains(method.getName()))return true;return false;}
    public Object create(String aliases, Object... args) throws Exception {
        Class<?> c = type(aliases);
        for (Constructor<?> constructor : c.getDeclaredConstructors()) if (matches(constructor.getParameterTypes(), args)) {
            constructor.setAccessible(true); return constructor.newInstance(converted(constructor.getParameterTypes(), args));
        }
        throw new NoSuchMethodException(c.getName() + " constructor/" + args.length);
    }
    public Object optionalField(Object target, String names) { try { return field(target, names); } catch (Exception ignored) { return null; } }
    public Object optionalCall(Object target, String names, Object... args) { try { return call(target, names, args); } catch (Exception ignored) { return null; } }
    private static List<Class<?>> hierarchy(Class<?> initial) {
        LinkedHashSet<Class<?>> result = new LinkedHashSet<>(); ArrayDeque<Class<?>> queue = new ArrayDeque<>(); queue.add(initial);
        while (!queue.isEmpty()) { Class<?> c = queue.remove(); if (!result.add(c)) continue; if (c.getSuperclass() != null) queue.add(c.getSuperclass()); queue.addAll(Arrays.asList(c.getInterfaces())); }
        return new ArrayList<>(result);
    }
    private static boolean matches(Class<?>[] types, Object[] args) {
        if (types.length != args.length) return false;
        for (int i = 0; i < types.length; i++) {
            if (args[i] == null) { if (types[i].isPrimitive()) return false; continue; }
            if (types[i].isInstance(args[i])) continue;
            if (types[i].isPrimitive() && ((types[i] != boolean.class && types[i] != char.class && args[i] instanceof Number) || (types[i] == boolean.class && args[i] instanceof Boolean) || (types[i] == char.class && args[i] instanceof Character))) continue;
            return false;
        }
        return true;
    }
    private static Object convert(Class<?> type, Object value) {
        if (!(value instanceof Number n) || !type.isPrimitive()) return value;
        if (type == int.class) return n.intValue(); if (type == long.class) return n.longValue();
        if (type == float.class) return n.floatValue(); if (type == double.class) return n.doubleValue();
        if (type == byte.class) return n.byteValue(); if (type == short.class) return n.shortValue(); return value;
    }
    private static Object[] converted(Class<?>[] types, Object[] args) {
        Object[] out = new Object[args.length]; for (int i = 0; i < args.length; i++) out[i] = convert(types[i], args[i]); return out;
    }
}
