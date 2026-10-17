#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright';
import {PNG} from 'pngjs';
const run=promisify(execFile),stateDir=path.resolve('work/viewer-qa'),output=path.join(stateDir,'evidence');
await fs.mkdir(output,{recursive:true});
const cli=async(...args)=>JSON.parse((await run(process.execPath,['bin/mct.mjs',...args,'--state-dir',stateDir,'--compact'],{windowsHide:true,timeout:60000})).stdout);
const evidence={startedAt:new Date().toISOString(),checks:{}};let browser;
try{
  await run(process.execPath,['examples/create-demo.mjs','work/demo'],{windowsHide:true});
  const opened=await cli('map','open','work/demo/two-floor-house.schem');assert(opened.ok);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(opened.result.viewerUrl,{waitUntil:'networkidle'});await page.waitForFunction(()=>window.__mctReady);
  const roof=await page.screenshot({path:path.join(output,'roof.png')});
  await page.locator('#cut').evaluate(input=>{input.value='2';input.dispatchEvent(new Event('input'));});
  const cut=await page.screenshot({path:path.join(output,'interior.png')});
  const a=PNG.sync.read(roof),b=PNG.sync.read(cut);let changes=0;
  for(let y=300;y<750;y++)for(let x=350;x<1200;x++){const p=(y*a.width+x)*4;if(a.data[p]!==b.data[p]||a.data[p+1]!==b.data[p+1]||a.data[p+2]!==b.data[p+2])changes++;}
  assert(changes>20000,'Height cutting must change the actual 3D scene, beyond the slider label');evidence.checks.heightCutChangesWorldPixels=changes;
  const id=opened.result.session;await cli('map','camera',id,'--position','8,5,6','--target','8,5,6');await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>window.__mctReady);assert.equal(errors.length,0);evidence.checks.coincidentCameraDoesNotBreakRenderer=true;
  await cli('map','close',id);evidence.passed=true;console.log(JSON.stringify({passed:true,checks:evidence.checks,preview:path.join(output,'interior.png')}));
}catch(error){evidence.passed=false;evidence.error=String(error.stack||error);process.exitCode=1;console.error(evidence.error);}
finally{await browser?.close();await cli('daemon','stop');evidence.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'result.json'),JSON.stringify(evidence,null,2));}
