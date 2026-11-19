import { app, dialog, type BrowserWindow } from 'electron'
import type { IpcGuard } from './ipcGuard'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AgentService } from './agent'
import { AGENT_SEAT, type AgentSubmission, type ProviderDraft } from '../shared/agent'

export function registerAgent(home: string, window: () => BrowserWindow | null, board: () => string, ipc: IpcGuard): AgentService {
  const filename = process.platform === 'win32' ? 'fuxi.exe' : 'fuxi'
  const service = new AgentService({
    home,
    executable: () => {
      const override = process.env['FLYINGDRAWS_FUXI_BIN']
      const candidates = override ? [override] : [join(process.resourcesPath, 'fuxi', filename), join(app.getAppPath(), 'resources', 'fuxi', filename)]
      const found = candidates.find(path => existsSync(path))
      if (!found) throw new Error('尚未找到内置 Fuxi 内核。请运行 npm run fetch:fuxi 自动获取预编译内核，然后重新连接。')
      return found
    },
    mcpServers: {
      flying_draws: {
        command: process.execPath,
        args: [join(app.getAppPath(), 'out', 'bridge', 'index.js')],
        // The bridge reports this seat from its first call, so the canvas never shows
        // the client's own name ("fuxi") beside the seat the prompt asks for.
        env: { ELECTRON_RUN_AS_NODE: '1', FLYINGDRAWS_HOME: home, FLYINGDRAWS_SEAT: AGENT_SEAT },
        timeout_secs: 60
      }
    }
  })
  service.on('state', state => {
    const target = window()
    if (target && !target.isDestroyed()) target.webContents.send('agent:state', state)
  })
  ipc.handle('agent:state', () => service.snapshot())
  ipc.handle('agent:connect', (_event, requestedBoard: string) => {
    if (requestedBoard !== board()) throw new Error('画板已切换，请重新打开 Agent 面板')
    return service.connect(requestedBoard)
  })
  ipc.handle('agent:configure', (_event, draft: ProviderDraft) => service.configure(draft))
  ipc.handle('agent:model', (_event, provider: string, model: string) => service.selectModel(provider, model))
  ipc.handle('agent:approval-mode', (_event, mode: 'auto-safe' | 'full-access') => service.setApprovalMode(mode))
  ipc.handle('agent:workspace', async (_event, requestedBoard: string) => {
    if (requestedBoard !== board()) throw new Error('画板已切换，请重新选择目录')
    const target = window()
    const options = { title: '选择 Agent 工作目录', properties: ['openDirectory'] as ('openDirectory')[] }
    const result = target ? await dialog.showOpenDialog(target, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    if (requestedBoard !== board()) throw new Error('画板已切换，请重新选择目录')
    await service.setWorkspace(requestedBoard, result.filePaths[0])
    return result.filePaths[0]
  })
  ipc.handle('agent:new', (_event, requestedBoard: string) => {
    if (requestedBoard !== board()) throw new Error('画板已切换')
    return service.newTask(requestedBoard)
  })
  ipc.handle('agent:open', (_event, id: string) => {
    if (!service.snapshot().items.some(item => item.id === id && item.board === board())) throw new Error('任务不属于当前画板')
    return service.openTask(id)
  })
  ipc.handle('agent:submit', (_event, input: AgentSubmission) => {
    if (input.board !== board()) throw new Error('画板已切换，请重新发送')
    return service.submit(input)
  })
  ipc.handle('agent:execute', (_event, text: string) => {
    const active = service.snapshot()
    const item = active.items.find(i => i.id === active.activeItemId && !i.archived)
    if (item && item.board !== board()) throw new Error('画板已切换，请切回原画板或重新拟定计划')
    return service.execute(text)
  })
  ipc.handle('agent:cancel', () => service.cancel())
  ipc.handle('agent:approve', (_event, requestId: string, approved: boolean) => service.approve(requestId, approved))
  ipc.handle('agent:review', (_event, runId: string, verdict: 'approved' | 'rejected', note?: string) => service.review(runId, verdict, note))
  ipc.handle('agent:image', (_event, id: string) => service.image(id))
  ipc.handle('agent:round-diff', (_event, runId: string, path?: string) => {
    if (typeof runId !== 'string' || (path !== undefined && typeof path !== 'string')) throw new Error('参数无效')
    return service.roundDiff(runId, path)
  })
  return service
}
