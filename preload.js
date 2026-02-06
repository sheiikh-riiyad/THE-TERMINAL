const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  startScale: () => ipcRenderer.invoke('start-scale'),
  startScale2Dec: () => ipcRenderer.invoke('start-scale-2dec'),
  startScale3Dec: () => ipcRenderer.invoke('start-scale-3dec'),
  stopScale: () => ipcRenderer.invoke('stop-scale'),
  testScale: () => ipcRenderer.invoke('test-scale'),
  
  onScaleData: (callback) => {
    ipcRenderer.on('scale-data', (event, weight) => callback(weight))
  },

  dbCreate: (data) => ipcRenderer.invoke('db:create', data),
  dbList: () => ipcRenderer.invoke('db:list'),
  dbListUnprinted: () => ipcRenderer.invoke('db:list:unprinted'),
  dbListPrinted: () => ipcRenderer.invoke('db:list:printed'),
  dbMaxId: () => ipcRenderer.invoke('db:max-id'),
  dbDelete: (id) => ipcRenderer.invoke('db:delete', id),
  dbUpdate: (id, data) => ipcRenderer.invoke('db:update', { id, data }),
  dbCompanyGet: () => ipcRenderer.invoke('db:company:get'),
  dbCompanySave: (data) => ipcRenderer.invoke('db:company:save', data),
  dbUserCreate: (data) => ipcRenderer.invoke('db:user:create', data),
  dbUserList: () => ipcRenderer.invoke('db:user:list'),
  dbUserGet: (id) => ipcRenderer.invoke('db:user:get', id),
  dbUserUpdate: (id, data) => ipcRenderer.invoke('db:user:update', { id, data }),
  dbUserDelete: (id) => ipcRenderer.invoke('db:user:delete', id),
  dbProductCreate: (data) => ipcRenderer.invoke('db:product:create', data),
  dbProductList: () => ipcRenderer.invoke('db:product:list'),
  dbProductDelete: (id) => ipcRenderer.invoke('db:product:delete', id),
  dbPartyCreate: (data) => ipcRenderer.invoke('db:party:create', data),
  dbPartyList: () => ipcRenderer.invoke('db:party:list'),
  dbPartyUpdate: (id, data) => ipcRenderer.invoke('db:party:update', { id, data }),
  dbPartyDelete: (id) => ipcRenderer.invoke('db:party:delete', id),
  dbTruckCreate: (data) => ipcRenderer.invoke('db:truck:create', data),
  dbTruckList: () => ipcRenderer.invoke('db:truck:list'),
  dbTruckUpdate: (id, data) => ipcRenderer.invoke('db:truck:update', { id, data }),
  dbTruckDelete: (id) => ipcRenderer.invoke('db:truck:delete', id),
  dbDriverCreate: (data) => ipcRenderer.invoke('db:driver:create', data),
  dbDriverList: () => ipcRenderer.invoke('db:driver:list'),
  dbDriverUpdate: (id, data) => ipcRenderer.invoke('db:driver:update', { id, data }),
  dbDriverDelete: (id) => ipcRenderer.invoke('db:driver:delete', id),
  dbPackingTypeCreate: (data) => ipcRenderer.invoke('db:packingtype:create', data),
  dbPackingTypeList: () => ipcRenderer.invoke('db:packingtype:list'),
  dbPackingTypeUpdate: (id, data) => ipcRenderer.invoke('db:packingtype:update', { id, data }),
  dbPackingTypeDelete: (id) => ipcRenderer.invoke('db:packingtype:delete', id),
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  currentUser: () => ipcRenderer.invoke('auth:current'),

  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  quitAndInstallUpdate: () => ipcRenderer.invoke('updates:quitAndInstall'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('updates:status', (_event, payload) => callback(payload))
  }
})
