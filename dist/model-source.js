import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from './contracts.js';
const MAX_BYTES = 64 * 1024 * 1024;
export async function fingerprint(file) {
    try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_BYTES)
            return { path: file, error: 'not-a-file-or-too-large' };
        const bytes = await fs.readFile(file);
        return { path: file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, modifiedAt: stat.mtime.toISOString() };
    }
    catch (error) {
        return { path: file, error: error.code || String(error) };
    }
}
export async function readModelSource(file, assetRoot) {
    const source = await fingerprint(file);
    if (source.error)
        fail('MODEL_READ_FAILED', 'Cannot read model source', source);
    let data;
    try {
        data = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    }
    catch (error) {
        fail('INVALID_MODEL_JSON', 'Model source is not valid JSON', { path: file, reason: error.message });
    }
    const files = [source], warnings = [], allowedRoot = await fs.realpath(assetRoot || path.dirname(file));
    // The CLI is the file reader. Blockbench receives model data and embedded
    // images through its normal codec; it needs no host-filesystem permission.
    if (Array.isArray(data.textures))
        for (const texture of data.textures) {
            if (typeof texture.source === 'string' && texture.source.startsWith('data:image/')) {
                delete texture.path;
                delete texture.relative_path;
                continue;
            }
            const reference = texture.relative_path || texture.path || (typeof texture.source === 'string' && !texture.source.startsWith('data:') ? texture.source : undefined);
            if (!reference || typeof reference !== 'string')
                continue;
            const candidate = path.resolve(path.dirname(file), reference);
            let resolved;
            try {
                resolved = await fs.realpath(candidate);
            }
            catch {
                files.push({ path: candidate, error: 'ENOENT' });
                warnings.push(`Texture unavailable: ${reference}`);
                delete texture.path;
                delete texture.relative_path;
                delete texture.source;
                continue;
            }
            const rel = path.relative(allowedRoot, resolved);
            if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`))
                fail('TEXTURE_OUTSIDE_ROOT', 'Texture lies outside the model asset root; pass --asset-root for the intended project folder', { texture: resolved, assetRoot: allowedRoot });
            const entry = await fingerprint(resolved);
            files.push(entry);
            if (entry.error)
                fail('TEXTURE_READ_FAILED', 'Cannot read model texture', entry);
            const bytes = await fs.readFile(resolved);
            const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
            const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
            if (!png && !jpeg)
                fail('INVALID_TEXTURE', 'External textures must contain PNG or JPEG image bytes', { path: resolved });
            texture.source = `data:image/${png ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
            delete texture.path;
            delete texture.relative_path;
        }
    const sourceText = JSON.stringify(data);
    if (Buffer.byteLength(sourceText) > MAX_BYTES)
        fail('MODEL_TOO_LARGE', 'Model and embedded textures exceed 64 MiB');
    return { sourceText, files, warnings };
}
//# sourceMappingURL=model-source.js.map