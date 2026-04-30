import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const authMock = vi.hoisted(() => ({
  requireUserAuth: vi.fn(async () => ({
    session: { user: { id: 'user-1' } },
  })),
  isErrorResponse: vi.fn((value: unknown) => value instanceof Response),
}))

const prismaMock = vi.hoisted(() => ({
  userPreference: {
    findUnique: vi.fn(async () => ({
      analysisModel: 'llm::analysis',
      characterModel: 'img::character',
      locationModel: 'img::location',
      storyboardModel: 'img::storyboard',
      editModel: 'img::edit',
      videoModel: 'video::model',
      audioModel: 'audio::tts',
      videoRatio: '9:16',
      artStyle: 'realistic',
      ttsRate: '+0%',
      capabilityDefaults: JSON.stringify({
        'video::model': { duration: 15, resolution: '720p' },
      }),
    })),
  },
  project: {
    create: vi.fn(async () => ({
      id: 'project-1',
      name: 'Test Project',
      description: null,
      userId: 'user-1',
    })),
  },
  novelPromotionProject: {
    create: vi.fn(async () => ({ id: 'np-1', projectId: 'project-1' })),
  },
}))

vi.mock('@/lib/api-auth', () => authMock)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

describe('api specific - project create default audio model', () => {
  const routeContext = { params: Promise.resolve({}) }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('copies user preference audioModel into the new novel promotion project', async () => {
    const mod = await import('@/app/api/projects/route')
    const req = buildMockRequest({
      path: '/api/projects',
      method: 'POST',
      body: {
        name: 'Test Project',
        description: '',
      },
    })

    const res = await mod.POST(req, routeContext)
    expect(res.status).toBe(201)
    expect(prismaMock.project.create).toHaveBeenCalledWith({
      data: {
        name: 'Test Project',
        description: null,
        userId: 'user-1',
      },
    })
    expect(prismaMock.novelPromotionProject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-1',
        audioModel: 'audio::tts',
        capabilityOverrides: JSON.stringify({
          'video::model': { duration: 15, resolution: '720p' },
        }),
      }),
    })
  })

  it('does not set capabilityOverrides when user capabilityDefaults is empty', async () => {
    prismaMock.userPreference.findUnique.mockResolvedValueOnce({
      analysisModel: 'llm::analysis',
      characterModel: 'img::character',
      locationModel: 'img::location',
      storyboardModel: 'img::storyboard',
      editModel: 'img::edit',
      videoModel: 'video::model',
      audioModel: 'audio::tts',
      videoRatio: '9:16',
      artStyle: 'realistic',
      ttsRate: '+0%',
      // Empty stored value: parseCapabilitySelections treats '' like null/undefined.
      capabilityDefaults: '',
    })
    const mod = await import('@/app/api/projects/route')
    const req = buildMockRequest({
      path: '/api/projects',
      method: 'POST',
      body: {
        name: 'Test Project',
        description: '',
      },
    })

    const res = await mod.POST(req, routeContext)
    expect(res.status).toBe(201)
    expect(prismaMock.novelPromotionProject.create).toHaveBeenCalled()
    const calls = prismaMock.novelPromotionProject.create.mock.calls as unknown as Array<
      [{ data: Record<string, unknown> }]
    >
    const createArg = calls[0]![0]
    expect(createArg.data).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(createArg.data, 'capabilityOverrides')).toBe(false)
  })

  it('returns an explicit validation error when description exceeds the max length', async () => {
    const mod = await import('@/app/api/projects/route')
    const req = buildMockRequest({
      path: '/api/projects',
      method: 'POST',
      headers: {
        'accept-language': 'zh-CN',
      },
      body: {
        name: 'Test Project',
        description: 'a'.repeat(501),
      },
    })

    const res = await mod.POST(req, routeContext)
    const body = await res.json() as {
      error?: {
        code?: string
        message?: string
        details?: {
          field?: string
          limit?: number
        }
      }
    }

    expect(res.status).toBe(400)
    expect(body.error?.code).toBe('INVALID_PARAMS')
    expect(body.error?.message).toBe('项目描述不能超过 500 个字符。')
    expect(body.error?.details?.field).toBe('description')
    expect(body.error?.details?.limit).toBe(500)
    expect(prismaMock.project.create).not.toHaveBeenCalled()
  })
})
