import type { GenerateResult } from '@/lib/generators/base'
import type { OpenAICompatVideoRequest } from '../types'
import { createScopedLogger } from '@/lib/logging/core'
import {
  buildRenderedTemplateRequest,
  buildTemplateVariables,
  extractTemplateError,
  normalizeResponseJson,
  readJsonPath,
} from '@/lib/openai-compat-template-runtime'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { resolveOpenAICompatClientConfig } from './common'

const OPENAI_COMPAT_PROVIDER_PREFIX = 'openai-compatible:'
const PROVIDER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const logger = createScopedLogger({
  module: 'model-gateway.openai-compat.template-video',
  action: 'video_template_request',
})

function summarizePotentialMediaValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed.startsWith('data:')) {
    return `${trimmed.slice(0, 120)}...<data-url ${trimmed.length} chars>`
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed.length > 500
      ? `${trimmed.slice(0, 200)}...<url ${trimmed.length} chars>`
      : trimmed
  }
  return trimmed.length > 500
    ? `${trimmed.slice(0, 200)}...<${trimmed.length} chars>`
    : trimmed
}

function summarizeJsonLike(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => summarizeJsonLike(item))
  }
  if (!value || typeof value !== 'object') {
    return summarizePotentialMediaValue(value)
  }
  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(input)) {
    if (key === 'image' || key === 'image2' || key === 'img_url' || key === 'first_frame_url' || key === 'last_frame_url') {
      output[key] = summarizePotentialMediaValue(raw)
      continue
    }
    if (key === 'images' && Array.isArray(raw)) {
      output[key] = raw.map((item) => summarizePotentialMediaValue(item))
      continue
    }
    output[key] = summarizeJsonLike(raw)
  }
  return output
}

function summarizeRequestBody(body: BodyInit | undefined): unknown {
  if (!body) return null
  if (typeof body === 'string') {
    try {
      return summarizeJsonLike(JSON.parse(body) as unknown)
    } catch {
      return summarizePotentialMediaValue(body)
    }
  }
  if (body instanceof FormData) {
    const fields: Array<{ key: string; value: unknown }> = []
    for (const [key, value] of body.entries()) {
      if (typeof value === 'string') {
        fields.push({ key, value: summarizePotentialMediaValue(value) })
      } else {
        fields.push({
          key,
          value: {
            kind: 'file',
            name: value.name,
            type: value.type,
            size: value.size,
          },
        })
      }
    }
    return { kind: 'form-data', fields }
  }
  return { kind: typeof body }
}

function buildUnsupportedVideoFormatError(detail: string): Error {
  return new Error(`VIDEO_API_FORMAT_UNSUPPORTED: ${detail}`)
}

function encodeProviderToken(providerId: string): string {
  const value = providerId.trim()
  if (value.startsWith(OPENAI_COMPAT_PROVIDER_PREFIX)) {
    const uuid = value.slice(OPENAI_COMPAT_PROVIDER_PREFIX.length).trim()
    if (PROVIDER_UUID_PATTERN.test(uuid)) {
      return `u_${uuid.toLowerCase()}`
    }
  }
  return `b64_${Buffer.from(value, 'utf8').toString('base64url')}`
}

function encodeModelRef(modelRef: string): string {
  return Buffer.from(modelRef, 'utf8').toString('base64url')
}

function resolveModelRef(request: OpenAICompatVideoRequest): string {
  const modelId = typeof request.modelId === 'string' ? request.modelId.trim() : ''
  if (modelId) return modelId
  const parsed = typeof request.modelKey === 'string' ? parseModelKeyStrict(request.modelKey) : null
  if (parsed?.modelId) return parsed.modelId
  throw new Error('OPENAI_COMPAT_VIDEO_MODEL_REF_REQUIRED')
}

export async function generateVideoViaOpenAICompatTemplate(
  request: OpenAICompatVideoRequest,
): Promise<GenerateResult> {
  if (!request.template) {
    throw buildUnsupportedVideoFormatError('OPENAI_COMPAT_VIDEO_TEMPLATE_REQUIRED')
  }
  if (request.template.mediaType !== 'video') {
    throw buildUnsupportedVideoFormatError('OPENAI_COMPAT_VIDEO_TEMPLATE_MEDIA_TYPE_INVALID')
  }

  const config = await resolveOpenAICompatClientConfig(request.userId, request.providerId)
  const lastFrameImageUrl = typeof request.options?.lastFrameImageUrl === 'string' ? request.options.lastFrameImageUrl : ''
  const variables = buildTemplateVariables({
    model: request.modelId || '',
    prompt: request.prompt,
    image: request.imageUrl,
    images: [request.imageUrl],
    aspectRatio: typeof request.options?.aspectRatio === 'string' ? request.options.aspectRatio : undefined,
    resolution: typeof request.options?.resolution === 'string' ? request.options.resolution : undefined,
    size: typeof request.options?.size === 'string' ? request.options.size : undefined,
    duration: typeof request.options?.duration === 'number' ? request.options.duration : undefined,
    image2: lastFrameImageUrl || undefined,
    extra: request.options,
  })

  const createRequest = await buildRenderedTemplateRequest({
    baseUrl: config.baseUrl,
    endpoint: request.template.create,
    variables,
    defaultAuthHeader: `Bearer ${config.apiKey}`,
  })
  if (['POST', 'PUT', 'PATCH'].includes(createRequest.method) && !createRequest.body) {
    throw buildUnsupportedVideoFormatError('OPENAI_COMPAT_VIDEO_TEMPLATE_CREATE_BODY_REQUIRED')
  }
  logger.info({
    audit: true,
    message: 'video model final http request params',
    details: {
      providerId: request.providerId,
      modelId: request.modelId,
      modelKey: request.modelKey,
      method: createRequest.method,
      endpointUrl: createRequest.endpointUrl,
      headers: createRequest.headers,
      body: summarizeRequestBody(createRequest.body),
    },
  })
  const createResponse = await fetch(createRequest.endpointUrl, {
    method: createRequest.method,
    headers: createRequest.headers,
    ...(createRequest.body ? { body: createRequest.body } : {}),
  })
  const rawText = await createResponse.text().catch(() => '')
  const payload = normalizeResponseJson(rawText)

  if (!createResponse.ok) {
    const errorMessage = extractTemplateError(request.template, payload, createResponse.status)
    if ([404, 405, 415].includes(createResponse.status)) {
      throw buildUnsupportedVideoFormatError(errorMessage)
    }
    throw new Error(errorMessage)
  }

  if (request.template.mode === 'sync') {
    const outputUrl = readJsonPath(payload, request.template.response.outputUrlPath)
    if (typeof outputUrl === 'string' && outputUrl.trim()) {
      return {
        success: true,
        videoUrl: outputUrl.trim(),
      }
    }
    const outputUrls = readJsonPath(payload, request.template.response.outputUrlsPath)
    if (Array.isArray(outputUrls) && outputUrls.length > 0 && typeof outputUrls[0] === 'string') {
      return {
        success: true,
        videoUrl: String(outputUrls[0]).trim(),
      }
    }
    throw buildUnsupportedVideoFormatError('OPENAI_COMPAT_VIDEO_TEMPLATE_OUTPUT_NOT_FOUND')
  }

  const taskIdRaw = readJsonPath(payload, request.template.response.taskIdPath)
  const taskId = typeof taskIdRaw === 'string' ? taskIdRaw.trim() : ''
  if (!taskId) {
    throw buildUnsupportedVideoFormatError('OPENAI_COMPAT_VIDEO_TEMPLATE_TASK_ID_NOT_FOUND')
  }

  const providerToken = encodeProviderToken(config.providerId)
  const modelRefToken = encodeModelRef(resolveModelRef(request))

  return {
    success: true,
    async: true,
    requestId: taskId,
    externalId: `OCOMPAT:VIDEO:${providerToken}:${modelRefToken}:${taskId}`,
  }
}
