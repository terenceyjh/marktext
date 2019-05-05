import fs from 'fs'
import path from 'path'
import { app, ipcMain, Menu } from 'electron'
import log from 'electron-log'
import { ensureDirSync, isDirectory, isFile } from '../filesystem'
import { parseMenu } from '../keyboard/shortcutHandler'
import configureMenu from '../menu/templates'

class AppMenu {

  /**
   * @param {Preference} preferences The preferences instances.
   * @param {Keybindings} keybindings The keybindings instances.
   * @param {string} userDataPath The user data path.
   */
  constructor (preferences, keybindings, userDataPath) {
    const FILE_NAME = 'recently-used-documents.json'
    this.MAX_RECENTLY_USED_DOCUMENTS = 12

    this._preferences = preferences
    this._keybindings = keybindings
    this._userDataPath = userDataPath

    this.RECENTS_PATH = path.join(userDataPath, FILE_NAME)
    this.isOsxOrWindows = /darwin|win32/.test(process.platform)
    this.isOsx = process.platform === 'darwin'
    this.activeWindowId = -1
    this.windowMenus = new Map()

    this._listenForIpcMain()
  }

  addRecentlyUsedDocument (filePath) {
    const { isOsxOrWindows, isOsx, MAX_RECENTLY_USED_DOCUMENTS, RECENTS_PATH } = this

    if (isOsxOrWindows) app.addRecentDocument(filePath)
    if (isOsx) return

    let recentDocuments = this.getRecentlyUsedDocuments()
    const index = recentDocuments.indexOf(filePath)
    let needSave = index !== 0
    if (index > 0) {
      recentDocuments.splice(index, 1)
    }
    if (index !== 0) {
      recentDocuments.unshift(filePath)
    }

    if (recentDocuments.length > MAX_RECENTLY_USED_DOCUMENTS) {
      needSave = true
      recentDocuments.splice(MAX_RECENTLY_USED_DOCUMENTS, recentDocuments.length - MAX_RECENTLY_USED_DOCUMENTS)
    }

    this.updateAppMenu(recentDocuments)

    if (needSave) {
      ensureDirSync(this._userDataPath)
      const json = JSON.stringify(recentDocuments, null, 2)
      fs.writeFileSync(RECENTS_PATH, json, 'utf-8')
    }
  }

  getRecentlyUsedDocuments () {
    const { RECENTS_PATH, MAX_RECENTLY_USED_DOCUMENTS } = this
    if (!isFile(RECENTS_PATH)) {
      return []
    }

    try {
      let recentDocuments = JSON.parse(fs.readFileSync(RECENTS_PATH, 'utf-8'))
        .filter(f => f && (isFile(f) || isDirectory(f)))

      if (recentDocuments.length > MAX_RECENTLY_USED_DOCUMENTS) {
        recentDocuments.splice(MAX_RECENTLY_USED_DOCUMENTS, recentDocuments.length - MAX_RECENTLY_USED_DOCUMENTS)
      }
      return recentDocuments
    } catch (err) {
      log.error(err)
      return []
    }
  }

  clearRecentlyUsedDocuments () {
    const { isOsxOrWindows, isOsx, RECENTS_PATH } = this
    if (isOsxOrWindows) app.clearRecentDocuments()
    if (isOsx) return

    const recentDocuments = []
    this.updateAppMenu(recentDocuments)
    const json = JSON.stringify(recentDocuments, null, 2)
    ensureDirSync(this._userDataPath)
    fs.writeFileSync(RECENTS_PATH, json, 'utf-8')
  }

  addEditorMenu (window) {
    const { windowMenus } = this
    windowMenus.set(window.id, this.buildDefaultMenu(true))

    const { menu, shortcutMap } = windowMenus.get(window.id)
    const currentMenu = Menu.getApplicationMenu() // the menu may be null
    updateMenuItemSafe(currentMenu, menu, 'sourceCodeModeMenuItem', false)
    updateMenuItemSafe(currentMenu, menu, 'typewriterModeMenuItem', false)

    // FIXME: Focus mode is being ignored when you open a new window - inconsistency.
    // updateMenuItemSafe(currentMenu, menu, 'focusModeMenuItem', false)

    const { checked: isSourceMode } = menu.getMenuItemById('sourceCodeModeMenuItem')
    if (isSourceMode) {
      // BUG: When opening a file `typewriterMode` and `focusMode` will be reset by editor.
      //      If source code mode is set the editor must not change the values.
      const typewriterModeMenuItem = menu.getMenuItemById('typewriterModeMenuItem')
      const focusModeMenuItem = menu.getMenuItemById('focusModeMenuItem')
      typewriterModeMenuItem.enabled = false
      focusModeMenuItem.enabled = false
    }
    this._keybindings.registerKeyHandlers(window, shortcutMap)
  }

  removeWindowMenu (windowId) {
    // NOTE: Shortcut handler is automatically unregistered when window is closed.
    const { activeWindowId } = this
    this.windowMenus.delete(windowId)
    if (activeWindowId === windowId) {
      this.activeWindowId = -1
    }
  }

  getWindowMenuById (windowId) {
    const { menu } = this.windowMenus.get(windowId)
    if (!menu) {
      log.error(`getWindowMenuById: Cannot find window menu for id ${windowId}.`)
      throw new Error(`Cannot find window menu for id ${windowId}.`)
    }
    return menu
  }

  setActiveWindow (windowId) {
    if (this.activeWindowId !== windowId) {
      // Change application menu to the current window menu.
      Menu.setApplicationMenu(this.getWindowMenuById(windowId))
      this.activeWindowId = windowId
    }
  }

  buildDefaultMenu (createShortcutMap, recentUsedDocuments) {
    if (!recentUsedDocuments) {
      recentUsedDocuments = this.getRecentlyUsedDocuments()
    }

    const menuTemplate = configureMenu(this._keybindings, this._preferences, recentUsedDocuments)
    const menu = Menu.buildFromTemplate(menuTemplate)

    let shortcutMap = null
    if (createShortcutMap) {
      shortcutMap = parseMenu(menuTemplate)
    }

    return {
      shortcutMap,
      menu
    }
  }

  updateAppMenu (recentUsedDocuments) {
    if (!recentUsedDocuments) {
      recentUsedDocuments = this.getRecentlyUsedDocuments()
    }

    // "we don't support changing menu object after calling setMenu, the behavior
    // is undefined if user does that." That means we have to recreate the
    // application menu each time.

    // rebuild all window menus
    this.windowMenus.forEach((value, key) => {
      const { menu: oldMenu } = value
      const { menu: newMenu } = this.buildDefaultMenu(false, recentUsedDocuments)

      // all other menu items are set automatically
      updateMenuItem(oldMenu, newMenu, 'sourceCodeModeMenuItem')
      updateMenuItem(oldMenu, newMenu, 'typewriterModeMenuItem')
      updateMenuItem(oldMenu, newMenu, 'focusModeMenuItem')
      updateMenuItem(oldMenu, newMenu, 'sideBarMenuItem')
      updateMenuItem(oldMenu, newMenu, 'tabBarMenuItem')

      // update window menu
      value.menu = newMenu

      // update application menu if necessary
      const { activeWindowId } = this
      if (activeWindowId === key) {
        Menu.setApplicationMenu(newMenu)
      }
    })
  }

  updateLineEndingMenu (lineEnding) {
    updateLineEndingMenu(lineEnding)
  }

  updateAlwaysOnTopMenu (flag) {
    const menus = Menu.getApplicationMenu()
    const menu = menus.getMenuItemById('alwaysOnTopMenuItem')
    menu.checked = flag
  }

  _listenForIpcMain () {
    ipcMain.on('mt::add-recently-used-document', (e, pathname) => {
      this.addRecentlyUsedDocument(pathname)
    })

    ipcMain.on('menu-clear-recently-used', () => {
      this.clearRecentlyUsedDocuments()
    })
  }
}

const updateMenuItem = (oldMenus, newMenus, id) => {
  const oldItem = oldMenus.getMenuItemById(id)
  const newItem = newMenus.getMenuItemById(id)
  newItem.checked = oldItem.checked
}

const updateMenuItemSafe = (oldMenus, newMenus, id, defaultValue) => {
  let checked = defaultValue
  if (oldMenus) {
    const oldItem = oldMenus.getMenuItemById(id)
    if (oldItem) {
      checked = oldItem.checked
    }
  }
  const newItem = newMenus.getMenuItemById(id)
  newItem.checked = checked
}

// ----------------------------------------------

// HACKY: We have one application menu per window and switch the menu when
// switching windows, so we can access and change the menu items via Electron.

/**
 * Return the menu from the application menu.
 *
 * @param {string} menuId Menu ID
 * @returns {Electron.Menu} Returns the menu or null.
 */
export const getMenuItemById = menuId => {
  const menus = Menu.getApplicationMenu()
  return menus.getMenuItemById(menuId)
}

export const updateLineEndingMenu = lineEnding => {
  const menus = Menu.getApplicationMenu()
  const crlfMenu = menus.getMenuItemById('crlfLineEndingMenuEntry')
  const lfMenu = menus.getMenuItemById('lfLineEndingMenuEntry')
  if (lineEnding === 'crlf') {
    crlfMenu.checked = true
  } else {
    lfMenu.checked = true
  }
}

export const updateAutoSaveMenu = autoSave => {
  const menu = getMenuItemById('autoSaveMenuItem')
  menu.checked = autoSave
}

export const updateThemeMenu = theme => {
  const themeMenus = getMenuItemById('themeMenu')
  themeMenus.submenu.items.forEach(item => (item.checked = false))
  themeMenus.submenu.items
    .forEach(item => {
      if (item.id && item.id === theme) {
        item.checked = true
      }
    })
}

export default AppMenu
