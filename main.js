const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { SerialPort } = require('serialport')
const Database = require('better-sqlite3')
const bcrypt = require('bcrypt')

let mainWindow
let loginWindow
let port = null
let pollInterval = null
let lastWeight = 0
let db = null
let currentUser = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })
  // const indexPath = path.join(__dirname, "renderer", "build", "index.html");
  // mainWindow.loadFile(indexPath)
  mainWindow.loadURL('http://localhost:3000/')
  
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 840,
    height: 1040,
    resizable: true,
    minimizable: true,
    maximizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })
  loginWindow.loadFile(path.join(__dirname, 'login.html'))
}

function initDb() {
  const baseDir = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname
  const dbPath = path.join(baseDir, 'app.db')
  db = new Database(dbPath)
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
}

app.whenReady().then(() => {
  initDb()
  createLoginWindow()
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
    
    port = new SerialPort({
      path: '/dev/ttyUSB0',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoOpen: false
    })

    let buffer = ''

    port.on('open', () => {
      console.log('✅ Scale port opened')
      
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
    })

    port.on('close', () => {
      console.log('🔌 Port closed')
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
        
        console.log('🎯 Frame found:', frame)
        
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
            console.log('❌ Failed to parse digits:', digits)
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
            
            console.log(`⚖️ Weight: ${finalWeight.toFixed(decimalMode)} kg (${decimalMode} decimals)`)
            
            // Send to React
            if (mainWindow) {
              mainWindow.webContents.send('scale-data', finalWeight)
            }
          }
        } else {
          console.log('⚠️ Frame too short:', frame)
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
      specification,
      packingtype,
      fee,
      firstweight,
      firstweightdate,
      secondweight,
      secondweightdate,
      netweight,
      avarage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const info = stmt.run(
    data.drivername ?? null,
    data.trucknumber ?? null,
    data.sellername ?? null,
    data.buyername ?? null,
    data.productname ?? null,
    normalizeInt(data.userid),
    data.username ?? null,
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

ipcMain.handle('auth:login', (_event, payload) => {
  if (!db) {
    throw new Error('Database not initialized')
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

// Force 2 decimal mode
ipcMain.handle('start-scale-2dec', async () => {
  if (port && port.isOpen) {
    port.close()
  }
  if (pollInterval) {
    clearInterval(pollInterval)
  }

  try {
    console.log('🔢 Starting 2 decimal mode...')
    
    port = new SerialPort({
      path: '/dev/ttyUSB0',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none'
    })

    let buffer = ''

    port.on('open', () => {
      console.log('✅ Scale connected (2 decimal mode)')
      
      pollInterval = setInterval(() => {
        if (port.isOpen) {
          port.write(Buffer.from([0x05]))
        }
      }, 300)
    })

    port.on('data', (data) => {
      const str = data.toString('ascii')
      buffer += str
      
      // Find frames
      const start = buffer.indexOf('\x02')
      const end = buffer.indexOf('\x03')
      
      if (start !== -1 && end !== -1) {
        const frame = buffer.substring(start + 1, end)
        
        if (frame.length >= 9) {
          const sign = frame[0]
          const digits = frame.substring(1, 10)
          const rawWeight = parseInt(digits, 10)
          
          // Always divide by 100 (2 decimal places)
          let finalWeight = rawWeight / 100
          if (sign === '-') finalWeight = -finalWeight
          
          // Only update if changed
          if (Math.abs(finalWeight - lastWeight) > 0.01) {
            lastWeight = finalWeight
            console.log(`⚖️ ${finalWeight.toFixed(2)} kg`)
            
            if (mainWindow) {
              mainWindow.webContents.send('scale-data', finalWeight)
            }
          }
        }
        
        // Clear buffer
        buffer = buffer.substring(end + 1)
      }
      
      // Clean buffer
      if (buffer.length > 50) {
        buffer = buffer.substring(buffer.length - 20)
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
    console.log('🔢 Starting 3 decimal mode...')
    
    port = new SerialPort({
      path: '/dev/ttyUSB0',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none'
    })

    let buffer = ''

    port.on('open', () => {
      console.log('✅ Scale connected (3 decimal mode)')
      
      pollInterval = setInterval(() => {
        if (port.isOpen) {
          port.write(Buffer.from([0x05]))
        }
      }, 300)
    })

    port.on('data', (data) => {
      const str = data.toString('ascii')
      buffer += str
       console.log("======================data=========================>", data)
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
            console.log(`⚖️ ${finalWeight.toFixed(3)} kg`)
            
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
      console.log("======================data=========================>", data)
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
  console.log('🛑 Scale stopped')
  return 'Scale stopped'
})

// Test: Send specific commands to scale
ipcMain.handle('test-scale', async () => {
  if (!port || !port.isOpen) {
    return 'Scale not connected'
  }
  
  console.log('🧪 Testing scale communication...')
  
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
      console.log(`Sent command ${index + 1}`)
    }, index * 1000)
  })
  
  return 'Testing scale commands...'
})

app.on('before-quit', () => {
  if (pollInterval) clearInterval(pollInterval)
  if (port && port.isOpen) port.close()
})
