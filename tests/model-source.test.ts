import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ModelService} from '../src/models.js';
import {readModelSource} from '../src/model-source.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl9l1sAAAAASUVORK5CYII=','base64');
test('real model and texture bytes are transported, external edits detected, and reload resets baseline without saving',async()=>{
  const directory=await fs.mkdtemp(path.resolve('work/model-source-')),file=path.join(directory,'fixture.bbmodel'),texture=path.join(directory,'skin.png');
  await fs.writeFile(texture,png);await fs.writeFile(file,JSON.stringify({meta:{},textures:[{name:'skin',relative_path:'skin.png'}],elements:[{to:[1,1,1]}]}));
  const requests:any[]=[];
  const bridge={peers:new Map([['bb',{id:'bb',kind:'blockbench'}]]),request:async(_id:string,action:string,args:any)=>{requests.push({action,args});return{project:action==='model.reload'?'reloaded':'original'};}};
  const models=new ModelService(bridge as any);
  try{
    const opened=await models.call('open',{path:file,bridge:'bb'});assert.equal(opened.changed,false);
    const sent=JSON.parse(requests[0].args.sourceText);assert.equal(sent.textures[0].path,undefined);assert.match(sent.textures[0].source,/^data:image\/png;base64,/);
    const originalBytes=await fs.readFile(file);await fs.writeFile(texture,Buffer.concat([png,Buffer.from('texture-edit')]));
    const dirty=await models.call('inspect',{session:opened.id});assert.equal(dirty.changed,true);assert.deepEqual(dirty.changedFiles,[texture]);assert.deepEqual(await fs.readFile(file),originalBytes);
    assert.equal((await models.call('reload',{session:opened.id})).changed,false);
    await fs.writeFile(file,'{invalid');assert.equal((await models.call('inspect',{session:opened.id})).changed,true);
    await assert.rejects(models.call('reload',{session:opened.id}),(e:any)=>e.code==='INVALID_MODEL_JSON');assert.equal(models.sessions.get(opened.id).project,'reloaded');
  }finally{await models.close();}
});
test('model texture transport rejects assets outside its explicit project root',async()=>{
  const directory=await fs.mkdtemp(path.resolve('work/model-scope-')),sub=path.join(directory,'model');await fs.mkdir(sub);await fs.writeFile(path.join(directory,'skin.png'),png);
  const file=path.join(sub,'fixture.bbmodel');await fs.writeFile(file,JSON.stringify({meta:{},textures:[{relative_path:'../skin.png'}]}));
  await assert.rejects(readModelSource(file),(e:any)=>e.code==='TEXTURE_OUTSIDE_ROOT');assert.equal((await readModelSource(file,directory)).files.length,2);
});
