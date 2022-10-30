// -*- mode: js2; indent-tabs-mode: nil; js2-basic-offset: 4 -*-
// Start apps on custom workspaces
/* exported init enable disable */

const {Shell} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;

const WORKSPACE_ACTIVATION_SUSPENSION_TRIGGER = 1000;
const WORKSPACE_ACTIVATION_SUSPENSION_TIMEOUT = 2000;

class WindowMover {
    constructor() {
        this._settings = ExtensionUtils.getSettings();
        this._appSystem = Shell.AppSystem.get_default();
        this._appConfigs = new Map();
        this._appData = new Map();

        this._appsChangedId =
            this._appSystem.connect('installed-changed',
                this._updateAppData.bind(this));

        this._settings.connect('changed', this._updateAppConfigs.bind(this));
        this._updateAppConfigs();

        this._lastStartedAppId = null;
        this._lastAppStart = 0;
        this._suspendWorkspaceActivationUntil = 0;

        this._appsStateChangedId =
            this._appSystem.connect('app-state-changed',
                this._appStateChanged.bind(this));

    }

    _updateAppConfigs() {
        this._appConfigs.clear();

        this._settings.get_strv('application-list').forEach(v => {
            let [appId, num] = v.split(':');
            this._appConfigs.set(appId, parseInt(num) - 1);
        });

        this._updateAppData();
    }

    _updateAppData() {
        let ids = [...this._appConfigs.keys()];
        let removedApps = [...this._appData.keys()]
            .filter(a => !ids.includes(a.id));
        removedApps.forEach(app => {
            app.disconnect(this._appData.get(app).windowsChangedId);
            this._appData.delete(app);
        });

        let addedApps = ids
            .map(id => this._appSystem.lookup_app(id))
            .filter(app => app && !this._appData.has(app));

        addedApps.forEach(app => {
            let data = {
                windowsChangedId: app.connect('windows-changed',
                    this._appWindowsChanged.bind(this)),
                moveWindowsId: 0,
                windows: app.get_windows(),
                state: app.state,
            };
            this._appData.set(app, data);
        });
    }

    destroy() {
        if (this._appsChangedId) {
            this._appSystem.disconnect(this._appsChangedId);
            this._appsChangedId = 0;
        }

        if (this._appsStateChangedId) {
            this._appSystem.disconnect(this._appsStateChangedId);
            this._appsStateChangedId = 0;
        }

        if (this._settings) {
            this._settings.run_dispose();
            this._settings = null;
        }

        this._appConfigs.clear();
        this._updateAppData();
    }

    _listNewWindows(knownWindows, allWindows) {
        return allWindows.filter(w => !knownWindows.includes(w));
    }

    _hasNewWindows(app) {
        let data = this._appData.get(app);

        let newWindows = this._listNewWindows(data.windows, app.get_windows());

        return newWindows.length > 0;
    }


    _appStateChanged(appSystem, app) {
        let data = this._appData.get(app);

        if (!data) {
            return;
        }

        if (
            (
                data.state === Shell.AppState.STOPPED ||
                this._hasNewWindows(app)
            ) &&
            app.state !== Shell.AppState.STOPPED &&
            this._lastStartedAppId !== app.get_id()
        ) {
            this._lastStartedAppId = app.get_id();

            let appStartInterval = Date.now() - this._lastAppStart;
            this._lastAppStart = Date.now();

            if (appStartInterval < WORKSPACE_ACTIVATION_SUSPENSION_TRIGGER) {
                    this._suspendWorkspaceActivationUntil =
                        Date.now() + WORKSPACE_ACTIVATION_SUSPENSION_TIMEOUT;
            }
        }

        data.state = app.state;
    }

    _activateWorkspace(workspaceNum) {
        let workspaceManager = global.workspace_manager;
        let metaWorkspace = workspaceManager.get_workspace_by_index(workspaceNum);
        metaWorkspace.activate(global.get_current_time());
    }

    _moveWindow(window, workspaceNum) {
        if (window.skip_taskbar || window.is_on_all_workspaces())
            return;

        // ensure we have the required number of workspaces
        let workspaceManager = global.workspace_manager;
        for (let i = workspaceManager.n_workspaces; i <= workspaceNum; i++) {
            window.change_workspace_by_index(i - 1, false);
            workspaceManager.append_new_workspace(false, 0);
        }

        window.change_workspace_by_index(workspaceNum, false);
    }

    _appWindowsChanged(app) {
        let data = this._appData.get(app);
        let windows = app.get_windows();

        // If get_compositor_private() returns non-NULL on a removed windows,
        // the window still exists and is just moved to a different workspace
        // or something; assume it'll be added back immediately, so keep it
        // to avoid moving it again
        windows.push(...data.windows.filter(w => {
            return !windows.includes(w) && w.get_compositor_private() !== null;
        }));

        let workspaceNum = this._appConfigs.get(app.id);

        let newWindows = this._listNewWindows(data.windows, windows);
        newWindows.forEach(window => {
            this._moveWindow(window, workspaceNum);
        });

        if (
            newWindows.length &&
            Date.now() > this._suspendWorkspaceActivationUntil
        ) {
            this._activateWorkspace(workspaceNum);
        }

        data.windows = windows;
    }
}

let prevCheckWorkspaces;
let winMover;

/** */
function init() {
    ExtensionUtils.initTranslations();
}

/**
 * @returns {bool} - false (used as MetaLater handler)
 */
function myCheckWorkspaces() {
    let keepAliveWorkspaces = [];
    let foundNonEmpty = false;
    for (let i = this._workspaces.length - 1; i >= 0; i--) {
        if (!foundNonEmpty) {
            foundNonEmpty = this._workspaces[i].list_windows().some(
                w => !w.is_on_all_workspaces());
        } else if (!this._workspaces[i]._keepAliveId) {
            keepAliveWorkspaces.push(this._workspaces[i]);
        }
    }

    // make sure the original method only removes empty workspaces at the end
    keepAliveWorkspaces.forEach(ws => (ws._keepAliveId = 1));
    prevCheckWorkspaces.call(this);
    keepAliveWorkspaces.forEach(ws => delete ws._keepAliveId);

    return false;
}

/** */
function enable() {
    prevCheckWorkspaces = Main.wm._workspaceTracker._checkWorkspaces;
    Main.wm._workspaceTracker._checkWorkspaces = myCheckWorkspaces;

    winMover = new WindowMover();
}

/** */
function disable() {
    Main.wm._workspaceTracker._checkWorkspaces = prevCheckWorkspaces;
    winMover.destroy();
}
