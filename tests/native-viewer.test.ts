import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {nativeViewerHtml} from '../src/native-viewer.js';

test('live game viewer maintains one capture request across quick visibility changes and stops on page exit',async()=>{
  const script=nativeViewerHtml.match(/<script>([\s\S]*?)<\/script>/)![1],listeners=new Map<string,()=>void>(),timers=new Map<number,()=>void>(),img={src:''},status={textContent:''};
  let requests=0,nextTimer=0,complete!:(value:any)=>void;const revoked:string[]=[];
  const document={hidden:false,querySelector:(selector:string)=>selector==='#frame'?img:status,addEventListener:(type:string,listener:()=>void)=>listeners.set(type,listener)};
  vm.runInNewContext(script,{document,location:{search:'?session=fixture&key=local'},URLSearchParams,URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL:(url:string)=>revoked.push(url)},fetch:()=>{requests++;return new Promise(resolve=>{complete=resolve;});},setTimeout:(listener:()=>void)=>{const id=++nextTimer;timers.set(id,listener);return id;},clearTimeout:(id:number)=>timers.delete(id),addEventListener:(type:string,listener:()=>void)=>listeners.set(type,listener)});
  assert.equal(requests,1);document.hidden=true;listeners.get('visibilitychange')!();document.hidden=false;listeners.get('visibilitychange')!();assert.equal(requests,1);
  complete({ok:true,blob:async()=>new Blob(['png'])});await new Promise(resolve=>setImmediate(resolve));assert.equal(img.src,'blob:fixture');assert.equal(timers.size,1);
  document.hidden=true;listeners.get('visibilitychange')!();assert.equal(timers.size,0);document.hidden=false;listeners.get('visibilitychange')!();assert.equal(requests,2);
  listeners.get('pagehide')!();complete({ok:true,blob:async()=>new Blob(['png'])});await new Promise(resolve=>setImmediate(resolve));assert.equal(timers.size,0);assert.ok(revoked.includes('blob:fixture'));
});
