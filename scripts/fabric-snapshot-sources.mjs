#!/usr/bin/env node
/** Preserve every Java source used by the current content-addressed build. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fabric=path.join(root,'bridges/fabric'),source=path.join(fabric,'src/main/java/dev/mct/bridge');
const names=(await fs.readdir(source)).filter(name=>name.endsWith('.java')).sort();
const files=await Promise.all(names.map(async name=>({name,bytes:await fs.readFile(path.join(source,name))})));
const digest=crypto.createHash('sha256');for(const file of files)digest.update(file.bytes);const hash=digest.digest('hex');
const target=path.join(fabric,'source-snapshots',hash);await fs.mkdir(target,{recursive:true});
for(const file of files)await fs.writeFile(path.join(target,file.name),file.bytes);
console.log(hash);
