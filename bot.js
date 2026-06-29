const mc = require('minecraft-protocol')
const os = require('os')

let client
let loadedChunks = new Set()
let visiblePlayers = new Set()
let registered = false
let loggedIn = false
let myEntityId = null

let reportInterval = null
let afkTimeout = null
let autoShutdownTimeout = null
let idleHeartbeat = null
let keepAliveInterval = null

let reconnecting = false
let reconnectAttempts = 0
let shuttingDown = false

const PASSWORD = 'matkhau123'

function addLog(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`
  console.log(line)
}

function msUntilNextVNHour(targetHour) {
  const vnOffsetMs = 7 * 60 * 60 * 1000
  const now = new Date()
  const nowVN = new Date(now.getTime() + vnOffsetMs)
  const target = new Date(Date.UTC(
    nowVN.getUTCFullYear(), nowVN.getUTCMonth(), nowVN.getUTCDate(),
    targetHour, 0, 0
  ))
  if (nowVN.getTime() >= target.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1)
  }
  return target.getTime() - nowVN.getTime()
}

function scheduleAutoShutdown(targetHour = 5) {
  const delay = msUntilNextVNHour(targetHour)
  addLog(`🕐 Bot sẽ tự nghỉ sau ${(delay / 3600000).toFixed(2)} giờ (lúc ${targetHour}:00 sáng VN)`)
  autoShutdownTimeout = setTimeout(() => {
    goIdle(`Đã đến ${targetHour}:00 sáng VN`)
  }, delay)
}

function goIdle(reason) {
  shuttingDown = true
  addLog(`🌙 ${reason} → Ngắt kết nối, chuyển sang chế độ nghỉ.`)
  addLog('💤 Bot KHÔNG tự thoát process. Vào panel bấm Stop rồi Start khi muốn bật lại.')

  if (afkTimeout) clearTimeout(afkTimeout)
  if (reportInterval) clearInterval(reportInterval)
  if (autoShutdownTimeout) clearTimeout(autoShutdownTimeout)
  if (keepAliveInterval) clearInterval(keepAliveInterval)
  if (client) {
    try { client.end() } catch (e) {}
  }

  if (idleHeartbeat) clearInterval(idleHeartbeat)
  idleHeartbeat = setInterval(() => {
    addLog('💤 Đang nghỉ — chờ bạn Stop/Start trên panel.')
  }, 1800000)
}

function printSystemStats() {
  const procMem = process.memoryUsage()
  const procMemMB = (procMem.rss / 1024 / 1024).toFixed(1)
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const memPercent = ((usedMem / totalMem) * 100).toFixed(1)
  const uptime = process.uptime()
  const h = Math.floor(uptime / 3600)
  const m = Math.floor((uptime % 3600) / 60)
  const s = Math.floor(uptime % 60)

  addLog(`💻 RAM bot: ${procMemMB}MB | RAM hệ thống: ${(usedMem/1024/1024).toFixed(0)}/${(totalMem/1024/1024).toFixed(0)}MB (${memPercent}%) | Uptime: ${h}h${m}m${s}s`)
}

function connect() {
  loadedChunks.clear()
  visiblePlayers.clear()
  registered = false
  loggedIn = false
  myEntityId = null

  if (reportInterval) clearInterval(reportInterval)
  if (afkTimeout) clearTimeout(afkTimeout)
  if (keepAliveInterval) clearInterval(keepAliveInterval)

  client = mc.createClient({
    host: 'rune.pikamc.vn',
    port: 25078,
    username: 'lamthanh',
    version: '1.20.1',
    auth: 'offline',
    viewDistance: 2,
    hideErrors: true,
    keepAlive: true,
    connectTimeout: 30000,
    closeTimeout: 120000,
  })

  client.on('login', (packet) => {
    myEntityId = packet.entityId
    addLog('✅ Bot đã vào server')
    loadedChunks.clear()
    visiblePlayers.clear()
    reconnectAttempts = 0

    setTimeout(() => {
      if (keepAliveInterval) clearInterval(keepAliveInterval)
      keepAliveInterval = setInterval(() => {
        try {
          if (client) client.write('keep_alive', { keepAliveId: BigInt(Date.now()) })
        } catch(e) {}
      }, 15000)
    }, 5000)
  })

  client.on('map_chunk', (packet) => {
    loadedChunks.add(`${packet.x},${packet.z}`)
  })
  client.on('unload_chunk', (packet) => {
    loadedChunks.delete(`${packet.chunkX},${packet.chunkZ}`)
  })

  client.on('named_entity_spawn', (packet) => {
    visiblePlayers.add(packet.entityId)
  })
  client.on('entity_destroy', (packet) => {
    if (packet.entityIds) {
      packet.entityIds.forEach(id => visiblePlayers.delete(id))
    } else if (packet.entityId) {
      visiblePlayers.delete(packet.entityId)
    }
  })

  client.on('chat', (packet) => {
    const msg = typeof packet.message === 'string' ? packet.message : JSON.stringify(packet.message)
    addLog(`💬 ${msg}`)

    if (!registered && /register|đăng ký/i.test(msg) && !/đã đăng ký/i.test(msg)) {
      registered = true
      setTimeout(() => client.chat(`/register ${PASSWORD} ${PASSWORD}`), 2500)
    }
    if (!loggedIn && /login|đăng nhập/i.test(msg) && !/đã đăng nhập/i.test(msg)) {
      loggedIn = true
      setTimeout(() => client.chat(`/login ${PASSWORD}`), 2500)
    }
    if (/đăng nhập thành công/i.test(msg)) { loggedIn = true; addLog('🔑 Đăng nhập thành công!') }
    if (/đăng ký thành công/i.test(msg)) { registered = true; addLog('📝 Đăng ký thành công!') }
    if (/discord|liên kết/i.test(msg)) { goIdle('Cần link Discord, không thể tiếp tục') }
  })

  client.on('kicked', (reason) => {
    const r = typeof reason === 'string' ? reason : JSON.stringify(reason)
    addLog(`👢 Bị kick: ${r}`)
  })

  scheduleAfk()

  reportInterval = setInterval(() => {
    addLog(`📊 Chunk: ${loadedChunks.size} | Players gần bot: ${visiblePlayers.size}`)
    printSystemStats()
  }, 8000)

  client.on('end', () => {
    addLog('🔌 Mất kết nối')
    if (keepAliveInterval) clearInterval(keepAliveInterval)
    if (!shuttingDown) scheduleReconnect()
  })
  client.on('error', (err) => {
    addLog(`❌ Lỗi: ${err && err.message ? err.message : err}`)
    if (keepAliveInterval) clearInterval(keepAliveInterval)
    if (!shuttingDown) scheduleReconnect()
  })
}

function scheduleAfk() {
  const delay = 90000 + Math.random() * 90000
  afkTimeout = setTimeout(() => {
    if (client) {
      if (Math.random() < 0.6) {
        client.write('look', {
          yaw: Math.random() * 360,
          pitch: (Math.random() * 40) - 20,
          onGround: true,
        })
      } else if (myEntityId !== null) {
        client.write('entity_action', { entityId: myEntityId, actionId: 0, jumpBoost: 0 })
        setTimeout(() => {
          if (client) client.write('entity_action', { entityId: myEntityId, actionId: 1, jumpBoost: 0 })
        }, 600)
      }
    }
    scheduleAfk()
  }, delay)
}

function scheduleReconnect() {
  if (reconnecting || shuttingDown) return
  reconnecting = true
  if (afkTimeout) clearTimeout(afkTimeout)
  if (reportInterval) clearInterval(reportInterval)
  if (keepAliveInterval) clearInterval(keepAliveInterval)

  const delay = Math.min(180000 * Math.pow(1.5, reconnectAttempts), 600000)
  addLog(`⏳ Chờ ${Math.round(delay / 1000)}s rồi kết nối lại (lần thử ${reconnectAttempts + 1})...`)
  reconnectAttempts++

  setTimeout(() => {
    reconnecting = false
    connect()
  }, delay)
}

addLog('🚀 AFK Chunk Loader khởi động...')
scheduleAutoShutdown(5)
connect()
