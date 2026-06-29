const mc = require('minecraft-protocol')
const readline = require('readline')
const { exec } = require('child_process')

let client
let loadedChunks = new Set()
let visiblePlayers = new Set()
let registered = false
let loggedIn = false
let myEntityId = null
let connectedSince = null
const scriptStartTime = Date.now()

let pos = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }
let posKnown = false

let reportInterval = null
let afkTimeout = null
let autoShutdownTimeout = null
let idleHeartbeat = null
let reconnectTimeoutId = null
let nextReconnectAt = null

let reconnecting = false
let reconnectAttempts = 0
let totalReconnects = 0
let shuttingDown = false

const PASSWORD = 'matkhau123'

// ===== Termux wake-lock: giữ CPU/mạng không bị Android Doze cắt =====
function acquireWakeLock() {
  exec('termux-wake-lock', (err) => {
    if (err) {
      console.log('⚠️ Không gọi được termux-wake-lock — cần "pkg install termux-api" + app Termux:API (F-Droid).')
    } else {
      console.log('🔒 Đã giữ wake-lock, tránh Android tắt nền khi khóa màn hình.')
    }
  })
}
function releaseWakeLock() {
  exec('termux-wake-unlock', () => {})
}
// ======================================================================

function formatDuration(ms) {
  const min = Math.floor(ms / 60000)
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h${m}m` : `${m}m`
}
function memUsageMB() {
  return (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
}

// ===== Tự nghỉ theo giờ VN =====
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
  console.log(`🕐 Bot sẽ tự nghỉ sau ${(delay / 3600000).toFixed(2)} giờ (lúc ${targetHour}:00 sáng VN)`)
  autoShutdownTimeout = setTimeout(() => {
    goIdle(`Đã đến ${targetHour}:00 sáng VN`)
  }, delay)
}

function goIdle(reason) {
  shuttingDown = true
  connectedSince = null
  posKnown = false
  console.log(`🌙 ${reason} → Ngắt kết nối, chuyển sang chế độ nghỉ.`)
  console.log('💤 Gõ "wake" trong console bất cứ lúc nào để bật lại.')

  if (afkTimeout) clearTimeout(afkTimeout)
  if (reportInterval) clearInterval(reportInterval)
  if (autoShutdownTimeout) clearTimeout(autoShutdownTimeout)
  if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId)
  nextReconnectAt = null
  if (client) {
    try { client.end() } catch (e) {}
  }
  releaseWakeLock() // không cần giữ pin lúc đang nghỉ chủ động

  if (idleHeartbeat) clearInterval(idleHeartbeat)
  idleHeartbeat = setInterval(() => {
    console.log(`💤 [${new Date().toLocaleTimeString()}] Đang nghỉ — gõ "wake" để bật lại.`)
  }, 1800000)
}

function wake() {
  if (!shuttingDown) {
    console.log('ℹ️ Bot đang hoạt động, không cần wake.')
    return
  }
  console.log('🌞 Đang bật lại bot...')
  shuttingDown = false
  reconnectAttempts = 0
  if (idleHeartbeat) clearInterval(idleHeartbeat)
  acquireWakeLock()
  scheduleAutoShutdown(5)
  connect()
}

function forceReconnect() {
  if (shuttingDown) {
    console.log('⚠️ Bot đang ở chế độ nghỉ. Gõ "wake" để bật lại trước.')
    return
  }
  console.log('🔄 Buộc kết nối lại ngay...')
  if (reconnectTimeoutId) { clearTimeout(reconnectTimeoutId); reconnectTimeoutId = null }
  nextReconnectAt = null
  reconnecting = true
  if (client) {
    try { client.end() } catch (e) {}
  }
  reconnectAttempts = 0
  setTimeout(() => {
    reconnecting = false
    connect()
  }, 500)
}

function showHelp() {
  console.log('───── 🛠️ LỆNH ĐIỀU KHIỂN ─────')
  console.log('help              - hiện danh sách lệnh')
  console.log('status            - xem trạng thái + thông số đầy đủ')
  console.log('say <tin nhắn>    - gửi chat lên server Minecraft')
  console.log('reconnect         - buộc kết nối lại ngay')
  console.log('idle              - cho bot nghỉ ngay')
  console.log('wake              - bật lại bot từ chế độ nghỉ')
  console.log('───────────────────────────────')
}

function showStatus() {
  console.log('───── 📋 TRẠNG THÁI BOT ─────')
  console.log(`🕐 Script chạy được: ${formatDuration(Date.now() - scriptStartTime)}`)
  console.log(`💾 RAM đang dùng: ${memUsageMB()} MB`)
  console.log(`🔁 Tổng số lần reconnect: ${totalReconnects}`)
  if (shuttingDown) {
    console.log('💤 Đang NGHỈ (chế độ idle). Gõ "wake" để bật lại.')
  } else if (client && loggedIn) {
    console.log(`✅ Đang kết nối. Online: ${connectedSince ? formatDuration(Date.now() - connectedSince) : '?'}`)
    console.log(`📦 Chunk đang load: ${loadedChunks.size}`)
    console.log(`👥 Players gần bot: ${visiblePlayers.size}`)
    console.log(`📍 Vị trí: ${posKnown ? `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}` : 'chưa rõ'}`)
    console.log(`📝 Registered: ${registered} | 🔑 LoggedIn: ${loggedIn}`)
  } else if (nextReconnectAt) {
    const remainSec = Math.max(0, Math.round((nextReconnectAt - Date.now()) / 1000))
    console.log(`⏳ Đang chờ kết nối lại sau ${remainSec}s (lần thử ${reconnectAttempts})`)
  } else {
    console.log('❓ Đang trong quá trình kết nối...')
  }
  console.log('─────────────────────────────')
}

function connect() {
  loadedChunks.clear()
  visiblePlayers.clear()
  registered = false
  loggedIn = false
  myEntityId = null
  posKnown = false

  if (reportInterval) clearInterval(reportInterval)
  if (afkTimeout) clearTimeout(afkTimeout)

  client = mc.createClient({
    host: 'rune.pikamc.vn',
    port: 25078,
    username: 'lamthanh',
    version: '1.20.1',
    auth: 'offline',
    viewDistance: 4,
    hideErrors: true,
    keepAlive: true,        // để thư viện tự xử lý keep_alive — KHÔNG tự gửi tay
    connectTimeout: 30000,
    closeTimeout: 180000,   // mạng di động dễ giật, cho phép chịu gián đoạn lâu hơn
  })

  client.on('kicked', (reason) => {
    const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason)
    console.log('👢 Bị kick:', reasonStr)
    try {
      const parsed = JSON.parse(reasonStr)
      let text = parsed.text
        ? (typeof parsed.text === 'string' ? parsed.text : JSON.stringify(parsed.text))
        : (parsed.extra ? JSON.stringify(parsed.extra) : JSON.stringify(parsed))
      console.log('👢 Lý do kick:', text)
      if (/banned|ban|đã bị cấm/i.test(text)) console.log('🚫 Bot có thể bị BAN!')
      if (/full|đầy server/i.test(text)) console.log('🏠 Server đang đầy!')
      if (/afk|di chuyển|không hoạt động/i.test(text)) console.log('🚶 Có thể bị kick do AFK!')
    } catch (e) {
      console.log('👢 (Không parse được JSON lý do kick — có thể là text thường.)')
    }
  })

  client.on('login', (packet) => {
    myEntityId = packet.entityId
    connectedSince = Date.now()
    console.log('✅ Bot đã vào server')
    loadedChunks.clear()
    visiblePlayers.clear()
    reconnectAttempts = 0
  })

  client.on('position', (packet) => {
    pos.x = packet.x
    pos.y = packet.y
    pos.z = packet.z
    pos.yaw = packet.yaw
    pos.pitch = packet.pitch
    posKnown = true
    if (packet.teleportId !== undefined) {
      try { client.write('teleport_confirm', { teleportId: packet.teleportId }) } catch (e) {}
    }
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
    console.log('💬', msg)

    if (!registered && /register|đăng ký/i.test(msg) && !/đã đăng ký/i.test(msg)) {
      registered = true
      setTimeout(() => client.chat(`/register ${PASSWORD} ${PASSWORD}`), 2500)
    }
    if (!loggedIn && /login|đăng nhập/i.test(msg) && !/đã đăng nhập/i.test(msg)) {
      loggedIn = true
      setTimeout(() => client.chat(`/login ${PASSWORD}`), 2500)
    }
    if (/đăng nhập thành công/i.test(msg)) {
      loggedIn = true
      console.log('🔑 Đăng nhập thành công!')
    }
    if (/đăng ký thành công/i.test(msg)) {
      registered = true
      console.log('📝 Đăng ký thành công!')
    }
    if (/discord|liên kết/i.test(msg)) {
      goIdle('Cần link Discord, không thể tiếp tục')
    }
  })

  scheduleAfk()

  reportInterval = setInterval(() => {
    console.log(`📊 [${new Date().toLocaleTimeString()}] Chunk: ${loadedChunks.size} | Players: ${visiblePlayers.size} | RAM: ${memUsageMB()}MB | Online: ${connectedSince ? formatDuration(Date.now() - connectedSince) : '?'}`)
  }, 15000)

  client.on('end', () => {
    console.log('🔌 Mất kết nối')
    connectedSince = null
    posKnown = false
    if (!shuttingDown) scheduleReconnect()
  })
  client.on('error', (err) => {
    console.log('❌ Lỗi:', err && err.message ? err.message : err)
    connectedSince = null
    posKnown = false
    if (!shuttingDown) scheduleReconnect()
  })
}

// ===== Anti-AFK: di chuyển vị trí thật một khoảng rất nhỏ rồi quay lại =====
function scheduleAfk() {
  const delay = 45000 + Math.random() * 55000 // 45s - 100s
  afkTimeout = setTimeout(() => {
    doAfkAction()
    scheduleAfk()
  }, delay)
}

function doAfkAction() {
  if (!client || !posKnown) return

  const newYaw = Math.random() * 360
  const newPitch = (Math.random() * 40) - 20
  const dx = (Math.random() < 0.5 ? 1 : -1) * (0.03 + Math.random() * 0.05)
  const dz = (Math.random() < 0.5 ? 1 : -1) * (0.03 + Math.random() * 0.05)

  try {
    client.write('position_look', {
      x: pos.x + dx, y: pos.y, z: pos.z + dz,
      yaw: newYaw, pitch: newPitch, onGround: true,
    })
  } catch (e) {}

  setTimeout(() => {
    if (client) {
      try {
        client.write('position_look', {
          x: pos.x, y: pos.y, z: pos.z,
          yaw: newYaw, pitch: newPitch, onGround: true,
        })
      } catch (e) {}
    }
  }, 1000 + Math.random() * 1000)

  if (myEntityId !== null && Math.random() < 0.3) {
    try {
      client.write('entity_action', { entityId: myEntityId, actionId: 0, jumpBoost: 0 })
      setTimeout(() => {
        if (client) {
          try { client.write('entity_action', { entityId: myEntityId, actionId: 1, jumpBoost: 0 }) } catch (e) {}
        }
      }, 500 + Math.random() * 500)
    } catch (e) {}
  }
}
// ============================================================================

function scheduleReconnect() {
  if (reconnecting || shuttingDown) return
  reconnecting = true
  if (afkTimeout) clearTimeout(afkTimeout)
  if (reportInterval) clearInterval(reportInterval)

  const delay = Math.min(180000 * Math.pow(1.5, reconnectAttempts), 900000)
  console.log(`⏳ Chờ ${Math.round(delay / 1000)}s rồi kết nối lại (lần thử ${reconnectAttempts + 1})...`)
  reconnectAttempts++
  totalReconnects++
  nextReconnectAt = Date.now() + delay

  reconnectTimeoutId = setTimeout(() => {
    nextReconnectAt = null
    reconnecting = false
    reconnectTimeoutId = null
    connect()
  }, delay)
}

// ===== Điều khiển realtime qua console =====
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const input = line.trim()
  if (!input) return
  const [cmd, ...rest] = input.split(' ')
  const arg = rest.join(' ')

  switch (cmd.toLowerCase()) {
    case 'help': showHelp(); break
    case 'status': showStatus(); break
    case 'say':
    case 'chat':
      if (!arg) console.log('⚠️ Cú pháp: say <tin nhắn>')
      else if (shuttingDown || !client) console.log('⚠️ Bot chưa kết nối hoặc đang nghỉ.')
      else {
        try { client.chat(arg); console.log(`📤 Đã gửi: ${arg}`) }
        catch (e) { console.log('❌ Gửi chat lỗi:', e.message) }
      }
      break
    case 'reconnect': forceReconnect(); break
    case 'idle':
    case 'pause':
      if (shuttingDown) console.log('ℹ️ Bot đã ở chế độ nghỉ.')
      else goIdle('Lệnh "idle" từ console')
      break
    case 'wake':
    case 'resume': wake(); break
    default: console.log(`❓ Không hiểu lệnh "${cmd}". Gõ "help" để xem.`)
  }
})
// ============================================

// ===== An toàn: không để Termux tự chết im lặng khi gặp lỗi không bắt được =====
process.on('uncaughtException', (err) => {
  console.log('🆘 Lỗi không bắt được (uncaughtException):', err && err.message ? err.message : err)
})
process.on('unhandledRejection', (reason) => {
  console.log('🆘 Promise lỗi không xử lý (unhandledRejection):', reason)
})
// ================================================================================

console.log('🚀 AFK Chunk Loader khởi động...')
console.log('💡 Gõ "help" để xem danh sách lệnh điều khiển realtime.')
acquireWakeLock()
scheduleAutoShutdown(5)
connect()
