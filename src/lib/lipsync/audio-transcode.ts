import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ffmpegStatic from 'ffmpeg-static'

interface TranscodeResult {
  buffer: Buffer
  mimeType: string
}

interface TranscodeOptions {
  forceTempFile?: boolean
}

function mapMimeTypeToFfmpegFormat(mimeType: string): string | null {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3'
  if (normalized.includes('mp4') || normalized.includes('m4a') || normalized.includes('aac')) return 'ipod'
  if (normalized.includes('ogg')) return 'ogg'
  if (normalized.includes('flac')) return 'flac'
  if (normalized.includes('wav')) return 'wav'
  return null
}

function mapMimeTypeToExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3'
  if (normalized.includes('mp4') || normalized.includes('m4a') || normalized.includes('aac')) return 'm4a'
  if (normalized.includes('ogg')) return 'ogg'
  if (normalized.includes('flac')) return 'flac'
  if (normalized.includes('wav')) return 'wav'
  return 'bin'
}

async function runFfmpegWithPipeInput(
  ffmpegCommand: string,
  inputBuffer: Buffer,
  inputMimeType: string,
): Promise<Buffer> {
  const inputFormat = mapMimeTypeToFfmpegFormat(inputMimeType)
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...(inputFormat ? ['-f', inputFormat] : []),
    '-i',
    'pipe:0',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-f',
    'wav',
    'pipe:1',
  ]
  const child = spawn(ffmpegCommand, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []

  child.stdout.on('data', (chunk) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })
  child.stderr.on('data', (chunk) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })

  const waitForExit = new Promise<void>((resolve, reject) => {
    child.on('error', (error) => {
      reject(new Error(`LIPSYNC_AUDIO_TRANSCODE_FAILED: ${error.message}`))
    })
    child.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
        reject(new Error(`LIPSYNC_AUDIO_TRANSCODE_FAILED: ${stderr || `ffmpeg exit code ${String(code)}`}`))
        return
      }
      resolve()
    })
  })

  child.stdin.write(inputBuffer)
  child.stdin.end()
  await waitForExit
  return Buffer.concat(stdoutChunks)
}

async function runFfmpegWithTempFileInput(
  ffmpegCommand: string,
  inputBuffer: Buffer,
  inputMimeType: string,
): Promise<Buffer> {
  const tempDir = await mkdtemp(join(tmpdir(), 'waoowaoo-lipsync-'))
  const ext = mapMimeTypeToExtension(inputMimeType)
  const inputPath = join(tempDir, `input.${ext}`)
  const outputPath = join(tempDir, 'output.wav')
  try {
    await writeFile(inputPath, inputBuffer)
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      'wav',
      outputPath,
    ]
    const child = spawn(ffmpegCommand, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stderrChunks: Buffer[] = []
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    await new Promise<void>((resolve, reject) => {
      child.on('error', (error) => {
        reject(new Error(`LIPSYNC_AUDIO_TRANSCODE_FAILED: ${error.message}`))
      })
      child.on('close', (code) => {
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
          reject(new Error(`LIPSYNC_AUDIO_TRANSCODE_FAILED: ${stderr || `ffmpeg exit code ${String(code)}`}`))
          return
        }
        resolve()
      })
    })
    return await readFile(outputPath)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export async function transcodeAudioToWav(
  inputBuffer: Buffer,
  inputMimeType: string,
  options?: TranscodeOptions,
): Promise<TranscodeResult> {
  const ffmpegCommand = process.env.FFMPEG_PATH?.trim() || ffmpegStatic || 'ffmpeg'
  const forceTempFile = options?.forceTempFile === true
  let outputBuffer: Buffer
  if (forceTempFile) {
    outputBuffer = await runFfmpegWithTempFileInput(ffmpegCommand, inputBuffer, inputMimeType)
  } else {
    try {
      outputBuffer = await runFfmpegWithPipeInput(ffmpegCommand, inputBuffer, inputMimeType)
    } catch {
      outputBuffer = await runFfmpegWithTempFileInput(ffmpegCommand, inputBuffer, inputMimeType)
    }
  }
  if (outputBuffer.length === 0) {
    throw new Error('LIPSYNC_AUDIO_TRANSCODE_FAILED: empty output')
  }

  return {
    buffer: outputBuffer,
    mimeType: 'audio/wav',
  }
}
