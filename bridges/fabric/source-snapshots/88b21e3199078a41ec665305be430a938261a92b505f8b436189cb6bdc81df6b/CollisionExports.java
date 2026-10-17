package dev.mct.bridge;

import com.google.gson.*;
import net.fabricmc.loader.api.FabricLoader;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.zip.GZIPOutputStream;

/** Incremental exact-registry export. Cached shapes and observed context cases have different guarantees. */
public final class CollisionExports {
    private final GameApi api;
    private final String version;
    private final Path directory;
    private final LinkedHashMap<String, Job> jobs = new LinkedHashMap<>();
    private Job active;
    private static final java.util.regex.Pattern IDENTIFIER = java.util.regex.Pattern.compile("[a-z0-9_.-]+:[a-z0-9_/.-]+");
    public CollisionExports(GameApi api, String version, Path directory) { this.api=api; this.version=version; this.directory=directory.resolve("exports"); }

    public Object request(JsonObject args) throws Exception {
        String operation=args.has("operation")?args.get("operation").getAsString():"start";
        if(operation.equals("start")) {
            if(active!=null&&!Set.of("completed","failed","cancelled").contains(active.status))throw new IllegalStateException("A collision export is already running");
            active=new Job(args); jobs.put(active.id,active);
            while(jobs.size()>4)jobs.remove(jobs.keySet().iterator().next());
            return active.result(args);
        }
        String id=args.has("jobId")?args.get("jobId").getAsString():"";Job job=jobs.get(id);if(job==null)throw new IllegalArgumentException("Unknown collision export job");
        if(operation.equals("cancel")){job.cancelled=true;if(!job.status.equals("completed"))job.status="cancelled";return job.result(args);}
        if(!operation.equals("status"))throw new IllegalArgumentException("operation must be start, status or cancel");
        return job.result(args);
    }
    public void advance(Object client,long tick) {
        Job job=active;if(job==null||!job.status.equals("running"))return;
        try{job.advance(client,tick);}catch(Exception error){job.error=error.toString();job.status="failed";}
    }
    public void close(){if(active!=null){active.cancelled=true;if(!active.status.equals("completed"))active.status="cancelled";}}

    private final class Job {
        final String id="collision_"+UUID.randomUUID(); final String startedAt=Instant.now().toString();
        final Iterator<?> iterator; final int total; final List<Object> rows=new ArrayList<>(),cases=new ArrayList<>(),unknownContexts=new ArrayList<>();
        final TreeMap<String,Object> defaults=new TreeMap<>();final Map<String,Map<String,Object>> indexed=new HashMap<>();
        final List<int[]> positions=new ArrayList<>(); final MessageDigest fingerprint=MessageDigest.getInstance("SHA-256");
        final Object emptyWorld,zero,emptyContext; final Class<?> worldInterface,contextInterface;
        volatile String status="running",error;volatile boolean cancelled;volatile Map<String,Object> dataset;volatile Path output;volatile String sha256;
        int processed,contextCursor;long firstTick=-1,lastTick;
        Job(JsonObject args)throws Exception{
            Object registry=api.field(api.type("net.minecraft.block.Block|net.minecraft.world.level.block.Block"),"STATE_IDS|BLOCK_STATE_REGISTRY");
            if(!(registry instanceof Iterable<?> iterable))throw new NoSuchMethodException("Game block-state registry is not iterable");iterator=iterable.iterator();Object count=api.optionalCall(registry,"size");total=count instanceof Number n?n.intValue():0;
            emptyWorld=api.field(api.type("EmptyBlockView|net.minecraft.world.level.EmptyBlockGetter"),"INSTANCE");
            zero=api.create("BlockPos|net.minecraft.core.BlockPos",0,0,0);
            worldInterface=api.type("BlockView|net.minecraft.world.level.BlockGetter");contextInterface=api.type("ShapeContext|net.minecraft.world.phys.shapes.CollisionContext");emptyContext=api.call(contextInterface,"absent|empty");
            if(!worldInterface.isInterface()||!contextInterface.isInterface())throw new NoSuchMethodException("Collision tracing requires the game's public context interfaces");
            if(args.has("contextPositions"))for(JsonElement element:args.getAsJsonArray("contextPositions")){JsonObject p=element.getAsJsonObject();positions.add(new int[]{coordinate(p,"x"),coordinate(p,"y"),coordinate(p,"z")});}
            if(args.has("contextBounds")){JsonObject b=args.getAsJsonObject("contextBounds"),min=b.getAsJsonObject("min"),max=b.getAsJsonObject("max");int x0=coordinate(min,"x"),y0=coordinate(min,"y"),z0=coordinate(min,"z"),x1=coordinate(max,"x"),y1=coordinate(max,"y"),z1=coordinate(max,"z");long w=(long)x1-x0+1,h=(long)y1-y0+1,d=(long)z1-z0+1;if(w<1||h<1||d<1||w>4096||h>4096||d>4096||w*h*d>4096)throw new IllegalArgumentException("contextBounds must contain at most 4096 positions");for(int x=x0;x<=x1;x++)for(int y=y0;y<=y1;y++)for(int z=z0;z<=z1;z++)positions.add(new int[]{x,y,z});}
            if(positions.size()>4096)throw new IllegalArgumentException("At most 4096 context positions are allowed");
        }
        void advance(Object client,long tick)throws Exception{
            if(cancelled){status="cancelled";return;}if(firstTick<0)firstTick=tick;lastTick=tick;
            long deadline=System.nanoTime()+8_000_000L;int count=0;
            while(iterator.hasNext()&&count++<128&&System.nanoTime()<deadline){Object state=iterator.next();Map<String,Object> ref=state(state);String key=key(ref);Map<String,Object> row=new LinkedHashMap<>(ref);row.put("stateId",processed++);
                String name=(String)ref.get("name");if(!defaults.containsKey(name)){Object block=api.call(state,"getBlock");defaults.put(name,state(api.call(block,"getDefaultState|defaultBlockState")));}
                try{
                    Object cache=api.optionalField(state,"shapeCache|cache");Object cached=cache==null?null:api.optionalField(cache,"collisionShape");
                    if(cached==null){row.put("shapes",null);row.put("source","context-required");row.put("reason","game-state-has-no-collision-cache");}
                    else{
                        List<Object> cachedBoxes=boxes(cached);Trace trace=new Trace(emptyWorld,zero,emptyContext);
                        List<Object> traced=boxes(api.call(state,"getCollisionShape",trace.worldProxy,zero,trace.contextProxy));
                        if(!trace.dependencies.isEmpty()||!trace.unsupported.isEmpty()||!trace.entityReads.isEmpty()||!BridgeMod.JSON.toJson(cachedBoxes).equals(BridgeMod.JSON.toJson(traced))){row.put("shapes",null);row.put("source","context-required");row.put("reason",!trace.entityReads.isEmpty()?"entity-context-read":!trace.dependencies.isEmpty()?"neighbor-context-read":"non-cache-equivalent-context");}
                        else{row.put("shapes",cachedBoxes);row.put("source","game-state-cache");}
                    }
                }catch(Exception failure){row.put("shapes",null);row.put("source","context-required");row.put("reason","collision-export-unavailable:"+failure.getClass().getSimpleName());}
                rows.add(row);indexed.put(key,row);fingerprint.update(BridgeMod.JSON.toJson(row).getBytes(StandardCharsets.UTF_8));
            }
            if(iterator.hasNext())return;
            Object world=api.optionalField(client,"world|level");
            while(contextCursor<positions.size()&&count++<128&&System.nanoTime()<deadline){int[] p=positions.get(contextCursor++);context(world,p);}
            if(contextCursor<positions.size())return;
            Map<String,Object> data=new LinkedHashMap<>();data.put("schemaVersion",1);data.put("gameVersion",version);data.put("source","fabric-exact-game-registry");data.put("shapeContext","empty");data.put("registryFingerprint",HexFormat.of().formatHex(fingerprint.digest()));data.put("defaultStates",new ArrayList<>(defaults.values()));data.put("states",rows);data.put("contextCases",cases);data.put("unsupportedContextSamples",unknownContexts);
            List<Object> mods=new ArrayList<>();FabricLoader.getInstance().getAllMods().stream().sorted(Comparator.comparing(m->m.getMetadata().getId())).forEach(mod->mods.add(Map.of("id",mod.getMetadata().getId(),"version",mod.getMetadata().getVersion().getFriendlyString())));
            data.put("provenance",Map.of("generatedAt",Instant.now().toString(),"startedAt",startedAt,"firstTick",firstTick,"lastTick",lastTick,"javaVersion",System.getProperty("java.version"),"mods",mods));
            data.put("semantics",Map.of("stateProperties","literal registry properties; no implicit placement or neighbor-state updates","staticShapes","actual cached shape, with empty-context equivalence and dependency checks","contextCasesExhaustive",false,"contextCaseScope","exact position, dimension, literal state and all recorded dependencies must match","entitySensitiveCases","unsupported; use live player validation","worldMutation",false));
            status="serializing";Thread writer=new Thread(()->write(data),"mct-collision-export");writer.setDaemon(true);writer.start();
        }
        void context(Object world,int[] p)throws Exception{
            Map<String,Object> position=Map.of("x",p[0],"y",p[1],"z",p[2]);
            if(world==null){unknownContexts.add(Map.of("position",position,"reason","no-loaded-world"));return;}
            Object pos=api.create("BlockPos|net.minecraft.core.BlockPos",p[0],p[1],p[2]);Object manager=api.call(world,"getChunkManager|getChunkSource");Object full=api.field(api.type("ChunkStatus|net.minecraft.world.level.chunk.status.ChunkStatus"),"FULL");
            if(api.call(manager,"getChunk",p[0]>>4,p[2]>>4,full,false)==null){unknownContexts.add(Map.of("position",position,"reason","chunk-not-loaded"));return;}
            Object state=api.call(world,"getBlockState",pos);Map<String,Object> ref=state(state);Map<String,Object> entry=indexed.get(key(ref));if(entry!=null&&entry.get("shapes")!=null)return;
            Trace trace=new Trace(world,pos,emptyContext);List<Object> traced;
            try{traced=boxes(api.call(state,"getCollisionShape",trace.worldProxy,pos,trace.contextProxy));}catch(Exception failure){unknownContexts.add(Map.of("position",position,"state",ref,"reason","context-trace-failed:"+failure.getClass().getSimpleName()));return;}
            List<Object> actual=boxes(api.call(state,"getCollisionShape",world,pos));String name=(String)ref.get("name");
            boolean entitySensitive=!trace.entityReads.isEmpty()||Set.of("minecraft:powder_snow","minecraft:scaffolding","minecraft:moving_piston").contains(name);
            if(entitySensitive||!trace.unsupported.isEmpty()||!BridgeMod.JSON.toJson(traced).equals(BridgeMod.JSON.toJson(actual))){unknownContexts.add(Map.of("position",position,"state",ref,"reason",entitySensitive?"entity-context-sensitive":!trace.unsupported.isEmpty()?"unsupported-world-read":"proxy-result-differs-from-real-world","entityReads",new ArrayList<>(trace.entityReads),"unsupportedReads",new ArrayList<>(trace.unsupported)));return;}
            Object dim=api.call(world,"getRegistryKey|dimension");Object identifier=api.call(dim,"getValue|identifier|location");
            Map<String,Object> sample=new LinkedHashMap<>();sample.put("state",ref);sample.put("position",position);sample.put("dimension",identifier.toString());sample.put("dependencies",new ArrayList<>(trace.dependencies.values()));sample.put("shapes",actual);sample.put("shapeContext","empty");sample.put("source","traced-game-world");sample.put("environment",trace.environment);cases.add(sample);
        }
        void write(Map<String,Object> data){
            try{if(cancelled){status="cancelled";return;}Files.createDirectories(directory);Path target=directory.resolve("collision-"+version+"-"+id+".json.gz"),temporary=target.resolveSibling(target.getFileName()+".part");
                try(OutputStream output=new GZIPOutputStream(Files.newOutputStream(temporary));Writer writer=new OutputStreamWriter(output,StandardCharsets.UTF_8)){BridgeMod.JSON.toJson(data,writer);}
                if(cancelled){Files.deleteIfExists(temporary);status="cancelled";return;}Files.move(temporary,target,StandardCopyOption.REPLACE_EXISTING);byte[] bytes=Files.readAllBytes(target);sha256=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));output=target;dataset=data;status="completed";
            }catch(Exception failure){error=failure.toString();status="failed";}
        }
        Map<String,Object> result(JsonObject args)throws Exception{Map<String,Object> out=new LinkedHashMap<>();out.put("jobId",id);out.put("state",status);out.put("gameVersion",version);out.put("processedStates",processed);out.put("totalStates",total);out.put("processedContextPositions",contextCursor);out.put("totalContextPositions",positions.size());out.put("observedAt",Instant.now().toString());if(error!=null)out.put("errorMessage",error);if(status.equals("completed")){out.put("datasetPath",output.toString());out.put("sha256",sha256);out.put("registryFingerprint",dataset.get("registryFingerprint"));out.put("staticStates",rows.stream().filter(row->((Map<?,?>)row).get("shapes")!=null).count());out.put("contextCases",cases.size());if(args.has("includeDataset")&&args.get("includeDataset").getAsBoolean())out.put("dataset",dataset);if(args.has("includeGzip")&&args.get("includeGzip").getAsBoolean())out.put("gzipBase64",Base64.getEncoder().encodeToString(Files.readAllBytes(output)));}return out;}
    }

    private final class Trace {
        final Object worldProxy,contextProxy,world,origin;final int ox,oy,oz;
        final LinkedHashMap<String,Object> dependencies=new LinkedHashMap<>();final Set<String> entityReads=new LinkedHashSet<>(),unsupported=new LinkedHashSet<>();final Map<String,Object> environment=new LinkedHashMap<>();
        Trace(Object world,Object origin,Object context)throws Exception{
            this.world=world;this.origin=origin;ox=((Number)api.call(origin,"getX")).intValue();oy=((Number)api.call(origin,"getY")).intValue();oz=((Number)api.call(origin,"getZ")).intValue();
            Class<?> view=api.type("BlockView|net.minecraft.world.level.BlockGetter"),shape=api.type("ShapeContext|net.minecraft.world.phys.shapes.CollisionContext");
            worldProxy=Proxy.newProxyInstance(view.getClassLoader(),new Class<?>[]{view},(proxy,method,args)->{
                Object[] a=args==null?new Object[0]:args;if(method.getDeclaringClass()==Object.class)return objectMethod(proxy,method,a);
                if(api.named(method,"getBlockState|getFluidState")&&a.length==1){Object p=a[0];Object block=api.call(world,"getBlockState",p);int x=((Number)api.call(p,"getX")).intValue()-ox,y=((Number)api.call(p,"getY")).intValue()-oy,z=((Number)api.call(p,"getZ")).intValue()-oz;Map<String,Object> dep=new LinkedHashMap<>();dep.put("offset",Map.of("x",x,"y",y,"z",z));dep.put("kind","block");dep.put("expectedState",state(block));dep.put("observedRead",api.named(method,"getFluidState")?"fluid":"block");dependencies.put(x+","+y+","+z,dep);}
                else if(api.named(method,"getHeight|getBottomY|getMinY|getMinBuildHeight")){environment.put(api.named(method,"getHeight")?"height":"minY",invoke(method,world,a));}
                else unsupported.add(method.getName());return invoke(method,world,a);
            });
            contextProxy=Proxy.newProxyInstance(shape.getClassLoader(),new Class<?>[]{shape},(proxy,method,args)->{Object[] a=args==null?new Object[0]:args;if(method.getDeclaringClass()==Object.class)return objectMethod(proxy,method,a);entityReads.add(method.getName());return invoke(method,context,a);});
        }
    }
    private static Object invoke(Method method,Object target,Object[] args)throws Throwable{try{return method.invoke(target,args);}catch(InvocationTargetException error){throw error.getCause();}}
    private static Object objectMethod(Object proxy,Method method,Object[] args){return switch(method.getName()){case "hashCode"->System.identityHashCode(proxy);case "equals"->proxy==args[0];default->"MCT traced collision context";};}
    private Map<String,Object> state(Object state){String serialized=state.toString();java.util.regex.Matcher matcher=IDENTIFIER.matcher(serialized);if(!matcher.find())throw new IllegalArgumentException("Unrecognized game state identifier: "+serialized);String name=matcher.group();TreeMap<String,String> properties=new TreeMap<>();int bracket=serialized.indexOf('[');if(bracket>=0&&serialized.endsWith("]"))for(String pair:serialized.substring(bracket+1,serialized.length()-1).split(",")){String[] item=pair.split("=",2);if(item.length==2)properties.put(item[0],item[1]);}Map<String,Object> ref=new LinkedHashMap<>();ref.put("name",name);ref.put("properties",properties);return ref;}
    private static String key(Map<String,Object> ref){return ref.get("name")+BridgeMod.JSON.toJson(ref.get("properties"));}
    private List<Object> boxes(Object shape)throws Exception{List<Object> out=new ArrayList<>();for(Object box:(Iterable<?>)api.call(shape,"getBoundingBoxes|toAabbs")){List<Double> values=new ArrayList<>();for(String coordinate:List.of("minX","minY","minZ","maxX","maxY","maxZ")){double value=((Number)api.field(box,coordinate)).doubleValue();if(!Double.isFinite(value))throw new IllegalArgumentException("Non-finite collision box");values.add(value);}out.add(values);}out.sort(Comparator.comparing(BridgeMod.JSON::toJson));return out;}
    private static int coordinate(JsonObject point,String key){if(point==null||!point.has(key))throw new IllegalArgumentException("Missing context coordinate: "+key);double value=point.get(key).getAsDouble();if(!Double.isFinite(value)||value!=Math.rint(value)||Math.abs(value)>30000000)throw new IllegalArgumentException("Context coordinates must be bounded integers");return(int)value;}
}
