const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const { autoUpdater } = require('electron-updater')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { SerialPort } = require('serialport')
const Database = require('better-sqlite3')
const bcrypt = require('bcrypt')

let mainWindow
let loginWindow
let port = null
let pollInterval = null
let lastWeight = 0
let db = null
let dbFilePath = ''
let currentUser = null
let dbBackupWatcher = null
let dbBackupTimer = null
let dbBackupInProgress = false
let dbBackupQueued = false
const iconPath = path.join(__dirname, 'app.png')
const appIcon = nativeImage.createFromPath(iconPath)
const SCALE_PORT = process.platform === 'win32' ? 'COM3 , COM4, COM2, COM1'  : '/dev/ttyUSB0'
const SCALE_DECIMAL_POS = 2
const LICENSE_PUBLIC_KEY_PEM = (() => {
  const envKey = process.env.LICENSE_PUBLIC_KEY_PEM
  if (envKey && envKey.trim()) return envKey
  const localKeyPath = path.join(__dirname, 'license_public.pem')
  if (fs.existsSync(localKeyPath)) {
    return fs.readFileSync(localKeyPath, 'utf8')
  }
  return ''
})()

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function fromBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : ''
  return Buffer.from(normalized + padding, 'base64')
}

function getMachineFingerprint() {
  const parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.userInfo().username
  ]
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex')
}

function getProductCode() {
  const raw = crypto
    .createHash('sha256')
    .update(`THE-TERMINAL|${getMachineFingerprint()}`)
    .digest('hex')
    .toUpperCase()
  return [raw.slice(0, 6), raw.slice(6, 12), raw.slice(12, 18), raw.slice(18, 24)].join('-')
}

function verifyLicenseCode(licenseCode) {
  if (!LICENSE_PUBLIC_KEY_PEM) {
    return { ok: false, message: 'License public key is not configured.' }
  }
  const pieces = String(licenseCode || '').trim().split('.')
  if (pieces.length !== 2) {
    return { ok: false, message: 'Invalid license code format.' }
  }
  const [payloadB64, signatureB64] = pieces
  let payload
  try {
    payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8'))
  } catch (_error) {
    return { ok: false, message: 'Invalid license payload.' }
  }
  let signature
  try {
    signature = fromBase64Url(signatureB64)
  } catch (_error) {
    return { ok: false, message: 'Invalid license signature.' }
  }

  const validSignature = crypto.verify(
    null,
    Buffer.from(payloadB64, 'utf8'),
    LICENSE_PUBLIC_KEY_PEM,
    signature
  )
  if (!validSignature) {
    return { ok: false, message: 'License signature validation failed.' }
  }

  const expectedProductCode = getProductCode()
  if (payload.productCode !== expectedProductCode) {
    return { ok: false, message: 'License does not match this machine.' }
  }

  const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return { ok: false, message: 'License expiry date is invalid.' }
  }
  if (expiresAt && expiresAt.getTime() < Date.now()) {
    return { ok: false, message: 'License is expired.', payload }
  }

  return { ok: true, payload }
}

function getLicenseRow() {
  if (!db) return null
  return db.prepare('SELECT * FROM license_state WHERE id = 1').get() || null
}

function getLicenseStatus() {
  const row = getLicenseRow()
  if (!row || !row.licensecode) {
    return { active: false, message: 'License not activated.' }
  }
  const result = verifyLicenseCode(row.licensecode)
  if (!result.ok) {
    return { active: false, message: result.message }
  }
  return {
    active: true,
    message: 'License active.',
    payload: result.payload,
    expiresAt: result.payload?.expiresAt || null
  }
}

function hasAdminUser() {
  if (!db) return false
  const row = db.prepare(
    "SELECT id FROM user_details WHERE lower(role) IN ('admin', 'super admin') LIMIT 1"
  ).get()
  return Boolean(row)
}

function getBootstrapContext() {
  const productCode = getProductCode()
  const license = getLicenseStatus()
  const adminExists = hasAdminUser()
  const needsLicense = !license.active
  const needsAdmin = license.active && !adminExists
  const canLogin = license.active && adminExists
  return {
    productCode,
    license,
    adminExists,
    needsLicense,
    needsAdmin,
    canLogin
  }
}

async function resolveScalePort() {
  try {
    const ports = await SerialPort.list()
    if (Array.isArray(ports) && ports.length > 0) {
      if (process.platform === 'win32') {
        const winPort = ports.find((p) => String(p.path || '').toUpperCase().startsWith('COM'))
        if (winPort?.path) return winPort.path
      }
      return ports[0].path || SCALE_PORT
    }
  } catch (error) {
    console.error('Failed to list serial ports:', error)
  }
  return SCALE_PORT
}


function sendUpdateStatus(payload) {
  if (mainWindow) {
    mainWindow.webContents.send('updates:status', payload)
  }
  if (loginWindow) {
    loginWindow.webContents.send('updates:status', payload)
  }
}

function initAutoUpdater() {
  if (!app.isPackaged) {
    return
  }

  autoUpdater.autoDownload = false

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus({ state: 'available', info })
  })

  autoUpdater.on('update-not-available', (info) => {
    sendUpdateStatus({ state: 'none', info })
  })

  autoUpdater.on('error', (error) => {
    sendUpdateStatus({ state: 'error', message: error?.message || String(error) })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus({
      state: 'downloading',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus({ state: 'downloaded', info })
  })

  autoUpdater.checkForUpdates().catch((error) => {
    sendUpdateStatus({ state: 'error', message: error?.message || String(error) })
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })
  if (!appIcon.isEmpty()) {
    mainWindow.setIcon(appIcon)
  }
  const indexPath = path.join(__dirname, "renderer", "build", "index.html");
  mainWindow.loadFile(indexPath)
  
  // mainWindow.loadURL('http://localhost:3000/')
  
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 840,
    height: 1040,
    resizable: true,
    minimizable: true,
    maximizable: true,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })
  if (!appIcon.isEmpty()) {
    loginWindow.setIcon(appIcon)
  }
  loginWindow.loadFile(path.join(__dirname, 'login.html'))
}

function resolveDbPath() {
  // Keep DB in a user-writable persistent folder so app updates do not remove it.
  const userDataDir = app.getPath('userData')
  fs.mkdirSync(userDataDir, { recursive: true })

  const persistentDbPath = path.join(userDataDir, 'app.db')
  if (fs.existsSync(persistentDbPath)) {
    return persistentDbPath
  }

  // One-time migration from legacy locations (install dir / app dir).
  const legacyCandidates = [
    path.join(path.dirname(app.getPath('exe')), 'app.db'),
    path.join(__dirname, 'app.db')
  ]

  for (const legacyPath of legacyCandidates) {
    if (!legacyPath || legacyPath === persistentDbPath) continue
    if (!fs.existsSync(legacyPath)) continue
    try {
      fs.copyFileSync(legacyPath, persistentDbPath)
      return persistentDbPath
    } catch (error) {
      console.error('Failed to migrate database from legacy path:', legacyPath, error)
    }
  }

  return persistentDbPath
}

function getInstalledBaseDir() {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname
}

function getDbBackupDir() {
  return path.join(app.getPath('desktop'), 'The-Terminal-Backup')
}

function ensureDbBackupDir() {
  const backupDir = getDbBackupDir()
  fs.mkdirSync(backupDir, { recursive: true })
  return backupDir
}

function syncBackupFile(sourcePath, destinationPath) {
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, destinationPath)
    return
  }
  if (fs.existsSync(destinationPath)) {
    fs.unlinkSync(destinationPath)
  }
}

function createDbBackup(reason = 'auto') {
  if (!dbFilePath) return
  if (dbBackupInProgress) {
    dbBackupQueued = true
    return
  }

  dbBackupInProgress = true
  try {
    const backupDir = ensureDbBackupDir()
    syncBackupFile(dbFilePath, path.join(backupDir, 'app.db'))
    syncBackupFile(`${dbFilePath}-wal`, path.join(backupDir, 'app.db-wal'))
    syncBackupFile(`${dbFilePath}-shm`, path.join(backupDir, 'app.db-shm'))
  } catch (error) {
    console.error('Failed to create DB backup:', error)
  } finally {
    dbBackupInProgress = false
    if (dbBackupQueued) {
      dbBackupQueued = false
      scheduleDbBackup('queued')
    }
  }
}

function scheduleDbBackup(reason = 'change', delayMs = 250) {
  if (dbBackupTimer) {
    clearTimeout(dbBackupTimer)
  }
  dbBackupTimer = setTimeout(() => {
    createDbBackup(reason)
  }, delayMs)
}

function initDbBackupWatcher() {
  if (!dbFilePath) return
  const watchDir = path.dirname(dbFilePath)
  try {
    dbBackupWatcher = fs.watch(watchDir, { persistent: false }, (_eventType, filename) => {
      const name = String(filename || '').toLowerCase()
      if (name === 'app.db' || name === 'app.db-wal' || name === 'app.db-shm') {
        scheduleDbBackup(`watch-${name}`)
      }
    })
  } catch (error) {
    console.error('Failed to start DB backup watcher:', error)
  }
}

function attachDbWriteBackupHook() {
  if (!db || db.__backupHookAttached) return
  const rawPrepare = db.prepare.bind(db)
  db.prepare = (...args) => {
    const stmt = rawPrepare(...args)
    if (stmt && typeof stmt.run === 'function' && !stmt.__runBackupWrapped) {
      const rawRun = stmt.run.bind(stmt)
      stmt.run = (...runArgs) => {
        const result = rawRun(...runArgs)
        scheduleDbBackup('db-write')
        return result
      }
      stmt.__runBackupWrapped = true
    }
    return stmt
  }
  db.__backupHookAttached = true
}

function initDb() {
  dbFilePath = resolveDbPath()
  db = new Database(dbFilePath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS weighments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drivername TEXT,
      trucknumber TEXT,
      sellername TEXT,
      buyername TEXT,
      productname TEXT,
      userid INTEGER,
      username TEXT,
      createdate TEXT,
      printed INTEGER,
      specification INTEGER,
      packingtype TEXT,
      fee INTEGER,
      firstweight INTEGER,
      firstweightdate TEXT,
      secondweight INTEGER,
      secondweightdate TEXT,
      netweight INTEGER,
      avarage INTEGER
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companyname TEXT,
      companyaddress TEXT,
      companycontact TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      email TEXT,
      contact TEXT,
      role TEXT,
      photo TEXT,
      password_hash TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productname TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS party_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      partyname TEXT,
      partyaddress TEXT,
      partyemail TEXT,
      partycontact TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS truck_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trucknumber TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS driver_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drivername TEXT,
      drivercontact TEXT,
      driveraddress TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS packingtype_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      packingtype TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS license_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      productcode TEXT,
      licensecode TEXT,
      payload TEXT,
      status TEXT,
      activatedat TEXT,
      expiresat TEXT
    )
  `)
  const userColumns = db.prepare('PRAGMA table_info(user_details)').all()
  const userColumnNames = new Set(userColumns.map((col) => col.name))
  if (!userColumnNames.has('password_hash')) {
    db.exec('ALTER TABLE user_details ADD COLUMN password_hash TEXT')
  }

  const columns = db.prepare('PRAGMA table_info(weighments)').all()
  const columnNames = new Set(columns.map((col) => col.name))
  if (!columnNames.has('firstweightdate')) {
    db.exec('ALTER TABLE weighments ADD COLUMN firstweightdate TEXT')
  }
  if (!columnNames.has('secondweightdate')) {
    db.exec('ALTER TABLE weighments ADD COLUMN secondweightdate TEXT')
  }
  if (!columnNames.has('packingtype')) {
    db.exec('ALTER TABLE weighments ADD COLUMN packingtype TEXT')
  }
  if (!columnNames.has('userid')) {
    db.exec('ALTER TABLE weighments ADD COLUMN userid INTEGER')
  }
  if (!columnNames.has('username')) {
    db.exec('ALTER TABLE weighments ADD COLUMN username TEXT')
  }
  if (!columnNames.has('createdate')) {
    db.exec('ALTER TABLE weighments ADD COLUMN createdate TEXT')
  }
  if (!columnNames.has('printed')) {
    db.exec('ALTER TABLE weighments ADD COLUMN printed INTEGER')
  }
  attachDbWriteBackupHook()
  initDbBackupWatcher()
  scheduleDbBackup('startup', 1000)
}

app.whenReady().then(() => {
  initDb()
  createLoginWindow()
  initAutoUpdater()
})

/* -------- SCALE LOGIC -------- */

// Main scale function with robust parsing
ipcMain.handle('start-scale', async () => {
  // Clean up any existing connection
  if (port && port.isOpen) {
    port.close()
  }
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }

  try {
    console.log('🚀 Starting scale connection...')
    
    const scalePath = await resolveScalePort()
    port = new SerialPort({
      path: scalePath,
      baudRate: 1200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoOpen: false
    })

    let buffer = Buffer.alloc(0)
    let textBuffer = ''

    port.on('open', () => {
      // console.log('✅ Scale port opened')
      
      // Start polling every 300ms
      pollInterval = setInterval(() => {
        if (port && port.isOpen) {
          port.write(Buffer.from([0x05])) // ENQ command
          // console.log('📤 Sent ENQ request')
        }
      }, 300)
    })

    port.on('data', (data) => {
      // Convert data to string and add to buffer
      const str = data.toString('ascii')
      buffer += str
      
      // DEBUG: Show raw data
      // console.log('📥 Raw:', str.replace(/\x02/g, '[STX]').replace(/\x03/g, '[ETX]'))
      
      // Process complete frames
      processBuffer()
    })

    port.on('error', (err) => {
      console.error('❌ Serial error:', err.message)
      // console.log( "the data" + data)
    })

    port.on('close', () => {
      // console.log('🔌 Port closed')
      if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
      }
      buffer = ''
    })

    // Helper function to process buffer
    function processBuffer() {
      // Look for complete frames: STX to ETX
      const startIndex = buffer.indexOf('\x02')
      const endIndex = buffer.indexOf('\x03')
      
      if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        // Extract frame
        const frame = buffer.substring(startIndex + 1, endIndex)
        
        // console.log('🎯 Frame found:', frame)
        
        // Parse the frame
        parseWeight(frame)
        
        // Remove processed data from buffer
        buffer = buffer.substring(endIndex + 1)
        
        // Process any remaining data
        if (buffer.length > 0) {
          processBuffer()
        }
      }
      
      // Prevent buffer from growing too large
      if (buffer.length > 100) {
        buffer = buffer.substring(buffer.length - 50)
      }
    }

    // Parse weight from frame
    function parseWeight(frame) {
      try {
        // Frame should be 9 or 10 characters (sign + 8 or 9 digits)
        if (frame.length >= 9) {
          const sign = frame[0]
          const digits = frame.substring(1, 10) // Take up to 9 digits
          
          // Parse raw weight
          const rawWeight = parseInt(digits, 10)
          
          if (isNaN(rawWeight)) {
            // console.log('❌ Failed to parse digits:', digits)
            return
          }
          
          // Try different decimal configurations
          let finalWeight
          let decimalMode
          
          // Test for 2 decimal places (most common for kg)
          const weight2Dec = rawWeight / 100
          const weight3Dec = rawWeight / 1000
          
          // Check which one makes more sense
          // If weight is reasonable (0-500 kg typically)
          if (weight2Dec >= 0 && weight2Dec <= 500) {
            finalWeight = weight2Dec
            decimalMode = 2
          } else if (weight3Dec >= 0 && weight3Dec <= 500) {
            finalWeight = weight3Dec
            decimalMode = 3
          } else {
            // Default to 2 decimal
            finalWeight = weight2Dec
            decimalMode = 2
          }
          
          // Apply sign
          if (sign === '-') {
            finalWeight = -finalWeight
          }
          
          // Only send if weight changed significantly (more than 0.001 kg)
          if (Math.abs(finalWeight - lastWeight) > 0.001) {
            lastWeight = finalWeight
            
            // console.log(`⚖️ Weight: ${finalWeight.toFixed(decimalMode)} kg (${decimalMode} decimals)`)
            
            // Send to React
            if (mainWindow) {
              mainWindow.webContents.send('scale-data', finalWeight)
            }
          }
        } else {
          // console.log('⚠️ Frame too short:', frame)
        }
      } catch (error) {
        console.error('Error parsing weight:', error)
      }
    }

    // Open the port
    port.open((err) => {
      if (err) {
        console.error('❌ Failed to open port:', err.message)
        return `Error: ${err.message}`
      }
      return 'Scale started successfully'
    })

    return 'Scale starting...'

  } catch (error) {
    console.error('❌ Failed to start scale:', error)
    return `Error: ${error.message}`
  }
})

/* -------- SQLITE DB LOGIC -------- */

function normalizeInt(value) {
  const num = Number(value)
  return Number.isFinite(num) ? Math.trunc(num) : null
}


ipcMain.handle('db:create', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const data = payload || {}
  const stmt = db.prepare(`
    INSERT INTO weighments (
      drivername,
      trucknumber,
      sellername,
      buyername,
      productname,
      userid,
      username,
      createdate,
      printed,
      specification,
      packingtype,
      fee,
      firstweight,
      firstweightdate,
      secondweight,
      secondweightdate,
      netweight,
      avarage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const createdDate = data.createdate ?? new Date().toISOString().split('T')[0]
  const info = stmt.run(
    data.drivername ?? null,
    data.trucknumber ?? null,
    data.sellername ?? null,
    data.buyername ?? null,
    data.productname ?? null,
    normalizeInt(data.userid),
    data.username ?? null,
    createdDate,
    normalizeInt(data.printed),
    normalizeInt(data.specification),
    data.packingtype ?? null,
    normalizeInt(data.fee),
    normalizeInt(data.firstweight),
    data.firstweightdate ?? null,
    normalizeInt(data.secondweight),
    data.secondweightdate ?? null,
    normalizeInt(data.netweight),
    normalizeInt(data.avarage)
  )
  return { id: info.lastInsertRowid }
})

ipcMain.handle('db:list', () => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const stmt = db.prepare('SELECT * FROM weighments ORDER BY id DESC')
  return stmt.all()
})

ipcMain.handle('db:list:unprinted', () => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const stmt = db.prepare('SELECT * FROM weighments WHERE printed IS NULL OR printed = 0 ORDER BY id DESC')
  return stmt.all()
})

ipcMain.handle('db:list:printed', () => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const stmt = db.prepare('SELECT * FROM weighments WHERE printed = 1 ORDER BY id DESC')
  return stmt.all()
})

ipcMain.handle('db:max-id', () => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const row = db.prepare('SELECT MAX(id) as maxId FROM weighments').get()
  return { maxId: row?.maxId ?? null }
})

ipcMain.handle('db:delete', (_event, id) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const stmt = db.prepare('DELETE FROM weighments WHERE id = ?')
  const info = stmt.run(Number(id))
  return { changes: info.changes }
})

ipcMain.handle('db:update', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const { id, data } = payload || {}
  if (!id) {
    throw new Error('Missing id for update')
  }
  const stmt = db.prepare(`
    UPDATE weighments
    SET
      drivername = ?,
      trucknumber = ?,
      sellername = ?,
      buyername = ?,
      productname = ?,
      userid = ?,
      username = ?,
      createdate = ?,
      printed = ?,
      specification = ?,
      packingtype = ?,
      fee = ?,
      firstweight = ?,
      firstweightdate = ?,
      secondweight = ?,
      secondweightdate = ?,
      netweight = ?,
      avarage = ?
    WHERE id = ?
  `)
  const info = stmt.run(
    data?.drivername ?? null,
    data?.trucknumber ?? null,
    data?.sellername ?? null,
    data?.buyername ?? null,
    data?.productname ?? null,
    normalizeInt(data?.userid),
    data?.username ?? null,
    data?.createdate ?? null,
    normalizeInt(data?.printed),
    normalizeInt(data?.specification),
    data?.packingtype ?? null,
    normalizeInt(data?.fee),
    normalizeInt(data?.firstweight),
    data?.firstweightdate ?? null,
    normalizeInt(data?.secondweight),
    data?.secondweightdate ?? null,
    normalizeInt(data?.netweight),
    normalizeInt(data?.avarage),
    Number(id)
  )
  return { changes: info.changes }
})

ipcMain.handle('db:company:get', () => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const stmt = db.prepare('SELECT * FROM company_details ORDER BY id DESC LIMIT 1')
  const row = stmt.get()
  return row || null
})

ipcMain.handle('db:company:save', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const data = payload || {}
  const existing = db.prepare('SELECT id FROM company_details ORDER BY id DESC LIMIT 1').get()
  if (existing?.id) {
    db.prepare(`
      UPDATE company_details
      SET companyname = ?, companyaddress = ?, companycontact = ?
      WHERE id = ?
    `).run(
      data.companyname ?? null,
      data.companyaddress ?? null,
      data.companycontact ?? null,
      existing.id
    )
    return { id: existing.id }
  }

  const info = db.prepare(`
    INSERT INTO company_details (companyname, companyaddress, companycontact)
    VALUES (?, ?, ?)
  `).run(
    data.companyname ?? null,
    data.companyaddress ?? null,
    data.companycontact ?? null
  )
  return { id: info.lastInsertRowid }
})

ipcMain.handle('db:user:create', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const data = payload || {}
  if (!data.password) {
    throw new Error('Password is required')
  }
  const passwordHash = bcrypt.hashSync(String(data.password), 10)
  const info = db.prepare(`
    INSERT INTO user_details (username, email, contact, role, photo, password_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    data.username ?? null,
    data.email ?? null,
    data.contact ?? null,
    data.role ?? null,
    data.photo ?? null,
    passwordHash
  )
  return { id: info.lastInsertRowid }
})

ipcMain.handle('db:user:list', () => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db.prepare('SELECT * FROM user_details ORDER BY id DESC').all()
})

ipcMain.handle('db:user:get', (_event, id) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const row = db.prepare('SELECT id, username, email, contact, role, photo FROM user_details WHERE id = ?').get(Number(id))
  return row || null
})

ipcMain.handle('db:user:update', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const { id, data } = payload || {}
  if (!id) {
    throw new Error('Missing id for update')
  }
  if (!data?.password) {
    throw new Error('Password is required')
  }
  const passwordHash = bcrypt.hashSync(String(data.password), 10)
  const info = db.prepare(`
    UPDATE user_details
    SET username = ?, email = ?, contact = ?, role = ?, photo = ?, password_hash = ?
    WHERE id = ?
  `).run(
    data?.username ?? null,
    data?.email ?? null,
    data?.contact ?? null,
    data?.role ?? null,
    data?.photo ?? null,
    passwordHash,
    Number(id)
  )
  return { changes: info.changes }
})

ipcMain.handle('db:user:delete', (_event, id) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const info = db.prepare('DELETE FROM user_details WHERE id = ?').run(Number(id))
  return { changes: info.changes }
})

ipcMain.handle('db:product:create', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const data = payload || {}
  const info = db.prepare(`
    INSERT INTO product_details (productname)
    VALUES (?)
  `).run(
    data.productname ?? null
  )
  return { id: info.lastInsertRowid }
})

ipcMain.handle('db:product:list', () => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db.prepare('SELECT * FROM product_details ORDER BY id DESC').all()
})

ipcMain.handle('db:product:delete', (_event, id) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const info = db.prepare('DELETE FROM product_details WHERE id = ?').run(Number(id))
  return { changes: info.changes }
})

ipcMain.handle('db:party:create', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const data = payload || {}
  const info = db.prepare(`
    INSERT INTO party_details (partyname, partyaddress, partyemail, partycontact)
    VALUES (?, ?, ?, ?)
  `).run(
    data.partyname ?? null,
    data.partyaddress ?? null,
    data.partyemail ?? null,
    data.partycontact ?? null
  )
  return { id: info.lastInsertRowid }
})

ipcMain.handle('db:party:list', () => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db.prepare('SELECT * FROM party_details ORDER BY id DESC').all()
})

ipcMain.handle('db:party:update', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const { id, data } = payload || {}
  if (!id) {
    throw new Error('Missing id for update')
  }
  const info = db.prepare(`
    UPDATE party_details
    SET partyname = ?, partyaddress = ?, partyemail = ?, partycontact = ?
    WHERE id = ?
  `).run(
    data?.partyname ?? null,
    data?.partyaddress ?? null,
    data?.partyemail ?? null,
    data?.partycontact ?? null,
    Number(id)
  )
  return { changes: info.changes }
})

ipcMain.handle('db:party:delete', (_event, id) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const info = db.prepare('DELETE FROM party_details WHERE id = ?').run(Number(id))
  return { changes: info.changes }
})

ipcMain.handle('db:truck:create', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const data = payload || {}
  const info = db.prepare(`
    INSERT INTO truck_details (trucknumber)
    VALUES (?)
  `).run(
    data.trucknumber ?? null
  )
  return { id: info.lastInsertRowid }
})

ipcMain.handle('db:truck:list', () => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db.prepare('SELECT * FROM truck_details ORDER BY id DESC').all()
})

ipcMain.handle('db:truck:update', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const { id, data } = payload || {}
  if (!id) {
    throw new Error('Missing id for update')
  }
  const info = db.prepare(`
    UPDATE truck_details
    SET trucknumber = ?
    WHERE id = ?
  `).run(
    data?.trucknumber ?? null,
    Number(id)
  )
  return { changes: info.changes }
})

ipcMain.handle('db:truck:delete', (_event, id) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const info = db.prepare('DELETE FROM truck_details WHERE id = ?').run(Number(id))
  return { changes: info.changes }
})

ipcMain.handle('db:driver:create', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const data = payload || {}
  const info = db.prepare(`
    INSERT INTO driver_details (drivername, drivercontact, driveraddress)
    VALUES (?, ?, ?)
  `).run(
    data.drivername ?? null,
    data.drivercontact ?? null,
    data.driveraddress ?? null
  )
  return { id: info.lastInsertRowid }
})

ipcMain.handle('db:driver:list', () => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db.prepare('SELECT * FROM driver_details ORDER BY id DESC').all()
})

ipcMain.handle('db:driver:update', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const { id, data } = payload || {}
  if (!id) {
    throw new Error('Missing id for update')
  }
  const info = db.prepare(`
    UPDATE driver_details
    SET drivername = ?, drivercontact = ?, driveraddress = ?
    WHERE id = ?
  `).run(
    data?.drivername ?? null,
    data?.drivercontact ?? null,
    data?.driveraddress ?? null,
    Number(id)
  )
  return { changes: info.changes }
})

ipcMain.handle('db:driver:delete', (_event, id) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const info = db.prepare('DELETE FROM driver_details WHERE id = ?').run(Number(id))
  return { changes: info.changes }
})

ipcMain.handle('db:packingtype:create', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const data = payload || {}
  const info = db.prepare(`
    INSERT INTO packingtype_details (packingtype)
    VALUES (?)
  `).run(
    data.packingtype ?? null
  )
  return { id: info.lastInsertRowid }
})

ipcMain.handle('db:packingtype:list', () => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db.prepare('SELECT * FROM packingtype_details ORDER BY id DESC').all()
})

ipcMain.handle('db:packingtype:update', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const { id, data } = payload || {}
  if (!id) {
    throw new Error('Missing id for update')
  }
  const info = db.prepare(`
    UPDATE packingtype_details
    SET packingtype = ?
    WHERE id = ?
  `).run(
    data?.packingtype ?? null,
    Number(id)
  )
  return { changes: info.changes }
})

ipcMain.handle('db:packingtype:delete', (_event, id) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const info = db.prepare('DELETE FROM packingtype_details WHERE id = ?').run(Number(id))
  return { changes: info.changes }
})

ipcMain.handle('auth:login', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const licenseStatus = getLicenseStatus()
  if (!licenseStatus.active) {
    return { ok: false, message: licenseStatus.message || 'License is not active.' }
  }
  if (!hasAdminUser()) {
    return { ok: false, message: 'Create super admin user first.' }
  }
  const { email, password } = payload || {}
  if (!email || !password) {
    return { ok: false, message: 'Email and password are required.' }
  }
  const row = db.prepare('SELECT id, username, email, contact, role, photo, password_hash FROM user_details WHERE email = ?').get(String(email))
  if (!row || !row.password_hash) {
    return { ok: false, message: 'Invalid email or password.' }
  }
  const isValid = bcrypt.compareSync(String(password), row.password_hash)
  if (!isValid) {
    return { ok: false, message: 'Invalid email or password.' }
  }

  currentUser = {
    id: row.id,
    username: row.username,
    email: row.email,
    contact: row.contact,
    role: row.role,
    photo: row.photo
  }

  if (loginWindow) {
    loginWindow.close()
    loginWindow = null
  }
  if (!mainWindow) {
    createWindow()
  }
  return { ok: true }
})

ipcMain.handle('auth:current', () => {
  return currentUser
})

ipcMain.handle('auth:bootstrap', () => {
  return getBootstrapContext()
})

ipcMain.handle('license:activate', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const licenseCode = String(payload?.licenseCode || '').trim()
  if (!licenseCode) {
    return { ok: false, message: 'License code is required.' }
  }
  const verification = verifyLicenseCode(licenseCode)
  if (!verification.ok) {
    return { ok: false, message: verification.message }
  }

  const productCode = getProductCode()
  const nowIso = new Date().toISOString()
  const expiresAt = verification.payload?.expiresAt || null
  const payloadJson = JSON.stringify(verification.payload || {})

  db.prepare(`
    INSERT INTO license_state (id, productcode, licensecode, payload, status, activatedat, expiresat)
    VALUES (1, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      productcode = excluded.productcode,
      licensecode = excluded.licensecode,
      payload = excluded.payload,
      status = excluded.status,
      activatedat = excluded.activatedat,
      expiresat = excluded.expiresat
  `).run(productCode, licenseCode, payloadJson, nowIso, expiresAt)

  return { ok: true, context: getBootstrapContext() }
})

ipcMain.handle('auth:create-initial-admin', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
  }
  const context = getBootstrapContext()
  if (!context.license.active) {
    return { ok: false, message: 'Activate license first.' }
  }
  if (context.adminExists) {
    return { ok: false, message: 'Admin user already exists.' }
  }

  const username = String(payload?.username || '').trim()
  const email = String(payload?.email || '').trim()
  const password = String(payload?.password || '')
  const contact = String(payload?.contact || '').trim()
  if (!username || !email || !password) {
    return { ok: false, message: 'Username, email and password are required.' }
  }

  const passwordHash = bcrypt.hashSync(password, 10)
  db.prepare(`
    INSERT INTO user_details (username, email, contact, role, photo, password_hash)
    VALUES (?, ?, ?, 'super admin', NULL, ?)
  `).run(username, email, contact || null, passwordHash)

  return { ok: true, context: getBootstrapContext() }
})

/* -------- AUTO UPDATE -------- */

ipcMain.handle('updates:check', async () => {
  if (!app.isPackaged) {
    return { ok: false, message: 'Updates are only available in packaged builds.' }
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    return { ok: true, info: result?.updateInfo ?? null }
  } catch (error) {
    return { ok: false, message: error?.message || String(error) }
  }
})

ipcMain.handle('updates:download', async () => {
  if (!app.isPackaged) {
    return { ok: false, message: 'Updates are only available in packaged builds.' }
  }
  try {
    await autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error?.message || String(error) }
  }
})

ipcMain.handle('updates:quitAndInstall', () => {
  if (!app.isPackaged) {
    return { ok: false, message: 'Updates are only available in packaged builds.' }
  }
  autoUpdater.quitAndInstall()
  return { ok: true }
})

// Force 2 decimal mode
ipcMain.handle('start-scale-2dec', async () => {
  if (port && port.isOpen) {
    port.close()
  }
  if (pollInterval) {
    clearInterval(pollInterval)
  }

  try {
    // console.log('🔢 Starting 2 decimal mode...')
    
    const scalePath = await resolveScalePort()
    port = new SerialPort({
      path: scalePath,
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none'
    })

    let buffer = Buffer.alloc(0)
    let textBuffer = ''

    port.on('open', () => {
      // console.log('✅ Scale connected (2 decimal mode)')
      
      pollInterval = setInterval(() => {
        if (port.isOpen) {
          port.write(Buffer.from([0x05]))
        }
      }, 300)
    })

    port.on('data', (data) => {
      // Show exactly what "screen /dev/ttyUSB0 9600" would show
      const asciiChunk = data.toString('ascii')
      process.stdout.write(asciiChunk)

      buffer = Buffer.concat([buffer, data])
      textBuffer += asciiChunk

      // Parse "screen" format like: +00000001B+
      const screenPattern = /([+-])(\d{6})(\d{2})([A-Za-z])\+/
      let match = textBuffer.match(screenPattern)
      while (match) {
        const sign = match[1] === '-' ? -1 : 1
        const valueStr = match[2]
        const rawValue = parseInt(valueStr, 10)
        if (!Number.isNaN(rawValue)) {
          const divisor = Math.pow(10, SCALE_DECIMAL_POS)
          const finalWeight = (rawValue / divisor) * sign
          const epsilon = 1 / Math.pow(10, Math.max(SCALE_DECIMAL_POS, 0))
          if (Math.abs(finalWeight - lastWeight) >= epsilon) {
            lastWeight = finalWeight
            // console.log(`⚖️ ${finalWeight.toFixed(SCALE_DECIMAL_POS)} kg`)
            if (mainWindow) {
              mainWindow.webContents.send('scale-data', finalWeight)
            }
          }
        }

        const idx = textBuffer.indexOf(match[0])
        textBuffer = textBuffer.slice(idx + match[0].length)
        match = textBuffer.match(screenPattern)
      }

      if (textBuffer.length > 128) {
        textBuffer = textBuffer.slice(-64)
      }

      while (true) {
        const start = buffer.indexOf(0x02)
        if (start === -1) {
          if (buffer.length > 64) {
            buffer = buffer.slice(-32)
          }
          break
        }
        const end = buffer.indexOf(0x03, start + 1)
        if (end === -1) {
          if (start > 0) {
            buffer = buffer.slice(start)
          }
          break
        }

        const frame = buffer.slice(start + 1, end)
        buffer = buffer.slice(end + 1)

        // XK3190-D10 frame (continuous): sign + 6 digits + decimal pos + XOR high + XOR low
        if (frame.length < 10) {
          continue
        }

        const signChar = String.fromCharCode(frame[0])
        const sign = signChar === '-' ? -1 : 1
        const digitsStr = frame.slice(1, 7).toString('ascii')
        const decimalPosStr = String.fromCharCode(frame[7])

        if (!/^[0-9]{6}$/.test(digitsStr) || !/^[0-4]$/.test(decimalPosStr)) {
          continue
        }

        const rawWeight = parseInt(digitsStr, 10)
        const decimalPos = parseInt(decimalPosStr, 10)
        const finalWeight = (rawWeight / Math.pow(10, decimalPos)) * sign

        const epsilon = 1 / Math.pow(10, Math.max(decimalPos, 0))
        if (Math.abs(finalWeight - lastWeight) >= epsilon) {
          lastWeight = finalWeight
          // console.log(`⚖️ ${finalWeight.toFixed(decimalPos)} kg`)
          if (mainWindow) {
            mainWindow.webContents.send('scale-data', finalWeight)
          }
        }
      }
    })

    return 'Scale started (2 decimals)'
  } catch (error) {
    console.error('Error:', error)
    return `Error: ${error.message}`
  }
})

// Force 3 decimal mode
ipcMain.handle('start-scale-3dec', async () => {
  if (port && port.isOpen) {
    port.close()
  }
  if (pollInterval) {
    clearInterval(pollInterval)
  }

  try {
    // console.log('🔢 Starting 3 decimal mode...')
    
    const scalePath = await resolveScalePort()
    port = new SerialPort({
      path: scalePath,
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none'
    })

    let buffer = ''

    port.on('open', () => {
      // console.log('✅ Scale connected (3 decimal mode)')
      
      pollInterval = setInterval(() => {
        if (port.isOpen) {
          port.write(Buffer.from([0x05]))
        }
      }, 300)
    })

    port.on('data', (data) => {
      const str = data.toString('ascii')
      buffer += str
      //  console.log("======================data=========================>", data)
      const start = buffer.indexOf('\x02')
      const end = buffer.indexOf('\x03')
      
      if (start !== -1 && end !== -1) {
        const frame = buffer.substring(start + 1, end)
        
        if (frame.length >= 9) {
          const sign = frame[0]
          const digits = frame.substring(1, 10)
          const rawWeight = parseInt(digits, 10)
          
          // Always divide by 1000 (3 decimal places)
          let finalWeight = rawWeight / 1000
          if (sign === '-') finalWeight = -finalWeight
          
          if (Math.abs(finalWeight - lastWeight) > 0.001) {
            lastWeight = finalWeight
            // console.log(`⚖️ ${finalWeight.toFixed(3)} kg`)
            
            if (mainWindow) {
              mainWindow.webContents.send('scale-data', finalWeight)
            }
          }
        }
        
        buffer = buffer.substring(end + 1)
      }
      
      if (buffer.length > 50) {
        buffer = buffer.substring(buffer.length - 20)
      }
      // console.log("======================data=========================>", data)
    })

    return 'Scale started (3 decimals)'
  } catch (error) {
    console.error('Error:', error)
    return `Error: ${error.message}`
  }
})

ipcMain.handle('stop-scale', () => {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
  
  if (port && port.isOpen) {
    port.close()
    port = null
  }
  
  lastWeight = 0
  // console.log('🛑 Scale stopped')
  return 'Scale stopped'
})

// Test: Send specific commands to scale
ipcMain.handle('test-scale', async () => {
  if (!port || !port.isOpen) {
    return 'Scale not connected'
  }
  
  // console.log('🧪 Testing scale communication...')
  
  // Send various commands
  const commands = [
    Buffer.from([0x05]),  // ENQ
    'Z\r\n',  // Zero
    'T\r\n',  // Tare
    'P\r\n',  // Print
  ]
  
  commands.forEach((cmd, index) => {
    setTimeout(() => {
      port.write(cmd)
      // console.log(`Sent command ${index + 1}`)
    }, index * 1000)
  })
  
  return 'Testing scale commands...'
})

app.on('before-quit', () => {
  if (pollInterval) clearInterval(pollInterval)
  if (port && port.isOpen) port.close()
  if (dbBackupWatcher) {
    dbBackupWatcher.close()
    dbBackupWatcher = null
  }
  if (dbBackupTimer) {
    clearTimeout(dbBackupTimer)
    dbBackupTimer = null
  }
  createDbBackup('before-quit')
})
