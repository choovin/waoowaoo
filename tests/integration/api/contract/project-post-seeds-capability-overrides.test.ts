import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

/**
 * Contract: POST /api/projects snapshots userPreference.capabilityDefaults into
 * novelPromotionProject.capabilityOverrides at creation (one-time; later user default changes do not update existing projects).
 */
const authMock = vi.hoisted(() => ({
  requireUserAuth: vi.fn(async () => ({
    session: { user: { id: 'user-1' } },
  })),
  isErrorResponse: vi.fn((value: unknown) => value instanceof Response),
}))

const prismaMock = vi.hoisted(() => ({
  userPreference: {
    findUnique: vi.fn(async () => ({
      analysisModel: null,
      characterModel: null,
      locationModel: null,
      storyboardModel: null,
      editModel: null,
      videoModel: 'ark::doubao-seedance-2-0-260128',
      audioModel: null,
      videoRatio: '9:16',
      artStyle: 'realistic',
      ttsRate: '+0%',
      capabilityDefaults: JSON.stringify({
        'ark::doubao-seedance-2-0-260128': { duration: 15 },
      }),
    })),
  },
  project: {
    create: vi.fn(async () => ({
      id: 'project-contract-1',
      name: 'Contract Project',
      description: null,
      userId: 'user-1',
    })),
  },
  novelPromotionProject: {
    create: vi.fn(async () => ({ id: 'np-contract-1', projectId: 'project-contract-1' })),
  },
}))

vi.mock('@/lib/api-auth', () => authMock)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

describe('contract: POST /api/projects seeds capabilityOverrides', () => {
  const routeContext = { params: Promise.resolve({}) }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists capabilityDefaults snapshot as project capabilityOverrides', async () => {
    const mod = await import('@/app/api/projects/route')
    const req = buildMockRequest({
      path: '/api/projects',
      method: 'POST',
      body: { name: 'Contract Project', description: '' },
    })

    const res = await mod.POST(req, routeContext)
    expect(res.status).toBe(201)
    expect(prismaMock.novelPromotionProject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-contract-1',
        capabilityOverrides: JSON.stringify({
          'ark::doubao-seedance-2-0-260128': { duration: 15 },
        }),
      }),
    })
  })
})
