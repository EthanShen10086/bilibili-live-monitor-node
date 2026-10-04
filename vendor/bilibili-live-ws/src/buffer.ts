import 'array-flat-polyfill'

export type { Buffer } from 'buffer'
export type Inflates = { inflateAsync: (b: Buffer) => Buffer | Promise<Buffer>, brotliDecompressAsync: (b: Buffer) => Buffer | Promise<Buffer>, Buffer: typeof Buffer }

const cutBuffer = (buffer: Buffer) => {
  const bufferPacks: Buffer[] = []
  let size: number
  for (let i = 0; i < buffer.length; i += size) {
    if (buffer.length - i < 16) throw new Error('Truncated frame')
    size = buffer.readInt32BE(i)
    if (size < 16 || size > buffer.length - i || buffer.readInt16BE(i + 4) !== 16) throw new Error('Invalid frame length')
    bufferPacks.push(buffer.slice(i, i + size))
  }
  return bufferPacks
}

export const makeDecoder = ({ inflateAsync, brotliDecompressAsync }: Inflates) => {
  const decoder = async (buffer: Buffer) => {
    const packs = await Promise.all(cutBuffer(buffer)
      .map(async buf => {
        const body = buf.slice(16)
        const protocol = buf.readInt16BE(6)
        const operation = buf.readInt32BE(8)

        let type = 'unknow'
        if (operation === 3) {
          type = 'heartbeat'
        } else if (operation === 5) {
          type = 'message'
        } else if (operation === 8) {
          type = 'welcome'
        }

        let data: any
        if (protocol === 0 || (protocol === 1 && (operation === 8 || operation === 5))) {
          data = JSON.parse(String(body))
        }
        if (protocol === 1 && body.length === 4) {
          data = body.readUIntBE(0, 4)
        }
        if (protocol === 2) {
          data = await decoder(await inflateAsync(body))
        }
        if (protocol === 3) {
          data = await decoder(await brotliDecompressAsync(body))
        }

        return { buf, type, protocol, data }
      }))

    return packs.flatMap(pack => {
      if (pack.protocol === 2 || pack.protocol === 3) {
        return pack.data as typeof packs
      }
      return pack
    })
  }

  return decoder
}

type EncodeType = 'heartbeat' | 'join'

export const encoder = (type: EncodeType, { Buffer }: Inflates, body: any = '') => {
  const blank = Buffer.alloc(16)
  if (typeof body !== 'string') {
    body = JSON.stringify(body)
  }
  const head = Buffer.from(blank)
  const buffer = Buffer.from(body)

  head.writeInt32BE(buffer.length + head.length, 0)
  head.writeInt16BE(16, 4)
  head.writeInt16BE(1, 6)
  if (type === 'heartbeat') {
    head.writeInt32BE(2, 8)
  }
  if (type === 'join') {
    head.writeInt32BE(7, 8)
  }
  head.writeInt32BE(1, 12)
  return Buffer.concat([head, buffer])
}
