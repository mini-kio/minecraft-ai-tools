import { PNG } from 'pngjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldNow } from 'node:timers/promises';
import { id, fail } from '../contracts.js';
export function blockColor(name) {
    if (/air$/.test(name))
        return [228, 236, 245];
    if (name === 'unknown')
        return [227, 45, 185];
    const palette = [[/grass|leaves|moss/, [84, 135, 66]], [/water/, [52, 107, 190]], [/glass/, [150, 207, 211]], [/sand|birch/, [213, 198, 144]], [/oak|wood|log|planks|chest|door/, [154, 112, 68]], [/snow|quartz|white|iron/, [212, 216, 219]], [/brick|terracotta|red/, [160, 86, 74]], [/stone|cobble|andesite/, [132, 137, 142]], [/deepslate|black|coal/, [61, 65, 72]], [/dirt|mud/, [120, 89, 65]]];
    for (const [test, color] of palette)
        if (test.test(name))
            return color;
    let h = 2166136261;
    for (const c of name)
        h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return [80 + (h >>> 0) % 140, 80 + (h >>> 8) % 140, 80 + (h >>> 16) % 140];
}
const FONT = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001111', '-': '000000111000000', '=': '000111000111000', 'x': '000101010101000', 'y': '101101111001110', 'z': '111001010100111', ' ': '000000000000000', ':': '000010000010000'
};
function pixel(image, x, y, color) { if (x < 0 || y < 0 || x >= image.width || y >= image.height)
    return; const i = (Math.floor(y) * image.width + Math.floor(x)) * 4; image.data[i] = color[0]; image.data[i + 1] = color[1]; image.data[i + 2] = color[2]; image.data[i + 3] = 255; }
function rect(image, x, y, w, h, color) { for (let py = Math.floor(y); py < y + h; py++)
    for (let px = Math.floor(x); px < x + w; px++)
        pixel(image, px, py, color); }
function text(image, value, x, y, color = [40, 48, 61]) { for (const c of value) {
    const glyph = FONT[c] ?? FONT[' '];
    for (let i = 0; i < 15; i++)
        if (glyph[i] === '1')
            pixel(image, x + i % 3, y + Math.floor(i / 3), color);
    x += 4;
} }
export async function renderSlice(reader, resolver, options, artifactDir) {
    const { bounds: b, axis, at } = options;
    const scale = Math.max(2, Math.min(24, Math.floor(options.scale ?? 10)));
    const margin = 38;
    const horizontal = axis === 'x' ? 'z' : 'x';
    const vertical = axis === 'y' ? 'z' : 'y';
    const width = b.max[horizontal] - b.min[horizontal] + 1;
    const height = b.max[vertical] - b.min[vertical] + 1;
    if ((width * scale + margin * 2) * (height * scale + margin * 2) > 20_000_000)
        throw new Error('Slice image exceeds 20 megapixels; reduce bounds or scale');
    const png = new PNG({ width: width * scale + margin * 2, height: height * scale + margin * 2 });
    png.data.fill(255);
    const legend = new Map();
    let unknown = 0;
    for (let row = 0; row < height; row++)
        for (let col = 0; col < width; col++) {
            if (options.signal?.aborted)
                fail('CANCELLED', 'Slice rendering cancelled');
            if (col === 0)
                await yieldNow();
            const p = { x: at, y: at, z: at };
            p[horizontal] = b.min[horizontal] + col;
            p[vertical] = axis === 'y' ? b.min[vertical] + row : b.max[vertical] - row;
            p[axis] = at;
            let block = await resolver.sample(reader, p.x, p.y, p.z);
            if (axis === 'y' && options.projection === 'floor') {
                for (let y = at; y >= b.min.y; y--) {
                    block = await resolver.sample(reader, p.x, y, p.z);
                    if (!block.known || !/:(air|cave_air|void_air)$/.test(block.name))
                        break;
                }
            }
            const materialColor = blockColor(block.name);
            if (!block.known)
                unknown++;
            legend.set(block.name, materialColor);
            // Equal floor/wall materials must remain distinguishable in the cutaway.
            // Surface depth supplies a consistent visual cue without inventing textures.
            const depthShade = options.projection === 'floor' && block.known ? Math.max(0.32, Math.pow(0.76, Math.max(0, at - block.position.y))) : 1;
            const color = materialColor.map(channel => Math.round(channel * depthShade));
            const px = margin + col * scale;
            const py = margin + row * scale;
            rect(png, px, py, scale, scale, color);
            if (scale >= 6) {
                rect(png, px, py, scale, 1, color.map(c => Math.max(0, c - 25)));
                rect(png, px, py, 1, scale, color.map(c => Math.max(0, c - 25)));
            }
            if (!block.known)
                for (let i = 0; i < scale; i++)
                    pixel(png, px + i, py + i, [90, 0, 80]);
        }
    text(png, `${axis}=${at}`, margin, 12);
    text(png, `${horizontal}:`, 5, 27);
    text(png, `${vertical}:`, 5, margin + 2);
    const tickX = Math.max(1, Math.ceil(30 / scale));
    for (let c = 0; c < width; c += tickX)
        text(png, String(b.min[horizontal] + c), margin + c * scale, 27);
    const tickY = Math.max(1, Math.ceil(12 / scale));
    for (let r = 0; r < height; r += tickY)
        text(png, String(axis === 'y' ? b.min[vertical] + r : b.max[vertical] - r), 4, margin + r * scale + 8);
    if (options.marker) {
        const x = margin + (options.marker[horizontal] - b.min[horizontal]) * scale;
        const v = options.marker[vertical];
        const y = margin + (axis === 'y' ? v - b.min[vertical] : b.max[vertical] - v + 1) * scale;
        rect(png, x - 2, y - 2, 5, 5, [255, 0, 0]);
    }
    await mkdir(artifactDir, { recursive: true });
    const imagePath = join(artifactDir, `${id('map_slice')}.png`);
    await writeFile(imagePath, PNG.sync.write(png));
    return { imagePath, axis, at, projection: options.projection ?? 'slice', bounds: b, coordinateAxes: { horizontal, vertical, verticalDirection: axis === 'y' ? 'increasing' : 'decreasing' }, unknownPixels: unknown, legend: Object.fromEntries(legend), shading: options.projection === 'floor' ? 'darker surfaces are farther below cutY' : 'flat block colors', imageSource: 'mct-block-color-slice', accuracy: 'block-state-color-diagram; resource-pack textures and entities are not rendered' };
}
export async function renderIsometric(blocks, b, artifactDir, signal) {
    const png = new PNG({ width: 1024, height: 768 });
    png.data.fill(255);
    const depth = new Float64Array(png.width * png.height).fill(-Infinity);
    const center = { x: (b.min.x + b.max.x + 1) / 2, y: (b.min.y + b.max.y + 1) / 2, z: (b.min.z + b.max.z + 1) / 2 };
    const scale = Math.min(28, 780 / (b.max.x - b.min.x + b.max.z - b.min.z + 2), 580 / (b.max.y - b.min.y + (b.max.x - b.min.x + b.max.z - b.min.z) * 0.5 + 2));
    const project = (v) => { const x = v[0] - center.x; const y = v[1] - center.y; const z = v[2] - center.z; return [512 + (x - z) * scale, 384 + ((x + z) * 0.5 - y) * scale, x + z + y]; };
    function triangle(a, c, d, color) {
        const minX = Math.max(0, Math.floor(Math.min(a[0], c[0], d[0])));
        const maxX = Math.min(png.width - 1, Math.ceil(Math.max(a[0], c[0], d[0])));
        const minY = Math.max(0, Math.floor(Math.min(a[1], c[1], d[1])));
        const maxY = Math.min(png.height - 1, Math.ceil(Math.max(a[1], c[1], d[1])));
        const denom = (c[1] - d[1]) * (a[0] - d[0]) + (d[0] - c[0]) * (a[1] - d[1]);
        if (Math.abs(denom) < 0.00001)
            return;
        for (let y = minY; y <= maxY; y++)
            for (let x = minX; x <= maxX; x++) {
                const u = ((c[1] - d[1]) * (x - d[0]) + (d[0] - c[0]) * (y - d[1])) / denom;
                const v = ((d[1] - a[1]) * (x - d[0]) + (a[0] - d[0]) * (y - d[1])) / denom;
                const w = 1 - u - v;
                if (u >= -EPSILON && v >= -EPSILON && w >= -EPSILON) {
                    const z = u * a[2] + v * c[2] + w * d[2];
                    const i = y * png.width + x;
                    if (z > depth[i]) {
                        depth[i] = z;
                        pixel(png, x, y, color);
                    }
                }
            }
    }
    let blockIndex = 0;
    for (const block of blocks) {
        if (signal?.aborted)
            fail('CANCELLED', 'Isometric rendering cancelled');
        if (blockIndex++ % 128 === 0)
            await yieldNow();
        if (/:(air|cave_air|void_air)$/.test(block.name))
            continue;
        const p = block.position;
        const color = blockColor(block.name);
        const shapes = block.shapes ?? [[0, 0, 0, 1, 1, 1]];
        const visibleShapes = shapes.length ? shapes : [[0, 0, 0, 1, 1, 1]];
        for (const s of visibleShapes) {
            const vertices = [[s[0], s[1], s[2]], [s[3], s[1], s[2]], [s[3], s[1], s[5]], [s[0], s[1], s[5]], [s[0], s[4], s[2]], [s[3], s[4], s[2]], [s[3], s[4], s[5]], [s[0], s[4], s[5]]].map(v => project([p.x + v[0], p.y + v[1], p.z + v[2]]));
            for (const [indices, factor] of [[[4, 5, 6, 7], 1], [[1, 2, 6, 5], 0.8], [[2, 3, 7, 6], 0.65]]) {
                const shade = color.map(c => Math.floor(c * factor));
                triangle(vertices[indices[0]], vertices[indices[1]], vertices[indices[2]], shade);
                triangle(vertices[indices[0]], vertices[indices[2]], vertices[indices[3]], shade);
            }
        }
    }
    text(png, `x=${b.min.x} ${b.max.x} y=${b.min.y} ${b.max.y} z=${b.min.z} ${b.max.z}`, 15, 15);
    await mkdir(artifactDir, { recursive: true });
    const imagePath = join(artifactDir, `${id('map_isometric')}.png`);
    await writeFile(imagePath, PNG.sync.write(png));
    return { imagePath, bounds: b, imageSource: 'mct-software-isometric', accuracy: 'approximate block colors and registered collision boxes; resource-pack textures, fluids, entities and lighting are not reproduced' };
}
const EPSILON = 0.000001;
//# sourceMappingURL=render.js.map