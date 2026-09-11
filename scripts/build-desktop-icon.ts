/** Build desktop platform icons from the shared DSH Desktop SVG. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'

const root = resolve(import.meta.dirname, '..')
const source = resolve(root, 'apps/desktop/assets/icon.svg')
const pngPath = resolve(root, 'apps/desktop/assets/icon.png')
const icoPath = resolve(root, 'apps/desktop/assets/icon.ico')
const svg = await readFile(source)
const png = await sharp(svg).resize(1024, 1024).png().toBuffer()
const windowsPng = await sharp(svg).resize(256, 256).png().toBuffer()

const header = Buffer.alloc(22)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)
header.writeUInt8(0, 6)
header.writeUInt8(0, 7)
header.writeUInt8(0, 8)
header.writeUInt8(0, 9)
header.writeUInt16LE(1, 10)
header.writeUInt16LE(32, 12)
header.writeUInt32LE(windowsPng.byteLength, 14)
header.writeUInt32LE(header.byteLength, 18)

await writeFile(pngPath, png)
await writeFile(icoPath, Buffer.concat([header, windowsPng]))
console.log(`build-desktop-icon: wrote ${pngPath} and ${icoPath}`)
