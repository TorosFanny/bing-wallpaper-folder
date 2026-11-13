// Bing Wallpaper Folder —— 文件夹即事实来源的 Bing 每日壁纸扩展
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Button as PanelButton} from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Bing from './bing.js';
import * as Lib from './library.js';

const POLL_INTERVAL_SECONDS = 3 * 3600;
const INITIAL_DELAY_SECONDS = 8;
const MONITOR_DEBOUNCE_MS = 800;
const ROW_THUMB_W = 96;
const ROW_THUMB_H = 54;
const HEADER_THUMB_W = 320;
const HEADER_THUMB_H = 180;
const THUMBS_PER_IDLE = 2;
// 内存中常驻的缩略图 content 上限（磁盘 PNG 缓存不受此限）
const THUMB_CACHE_MAX = 64;

function logInfo(msg) {
    console.log(`BingWallpaperFolder: ${msg}`);
}

function contentFromPixbuf(pixbuf) {
    const content = new St.ImageContent();
    const ok = content.set_data(
        global.stage.context.get_backend().get_cogl_context(),
        pixbuf.get_pixels(),
        pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
        pixbuf.get_width(),
        pixbuf.get_height(),
        pixbuf.get_rowstride());
    if (!ok)
        throw new Error('St.ImageContent.set_data 失败');
    return content;
}

const BingFolderIndicator = GObject.registerClass(
class BingFolderIndicator extends PanelButton {
    _init(extension) {
        super._init(0.0, 'Bing Wallpaper Folder');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._http = Bing.newSession();
        this._signals = [];
        this._timeouts = new Set();
        this._idleSources = new Set();
        this._entries = [];
        this._currentName = '';
        this._filter = '';
        this._page = 0;
        this._refreshing = false;
        this._thumbQueue = [];
        this._thumbCache = new Map();
        this._thumbLoaderId = null;
        this._headerEntry = null;
        this._memMonitor = null;
        this._memSignal = 0;
        this._menuSignal = 0;
        this._monitorSignal = 0;
        try {
            this._memMonitor = Gio.MemoryMonitor.dup_default();
            this._memSignal = this._memMonitor.connect(
                'low-memory-warning', (_o, level) => this._onMemoryPressure(level));
        } catch (e) {
            // 旧平台无 GMemoryMonitor 时静默降级
        }

        this._cacheDir = GLib.build_filenamev(
            [GLib.get_user_cache_dir(), 'bing-wallpaper-folder', 'thumbs']);
        try {
            Gio.File.new_for_path(this._cacheDir).make_directory_with_parents(null);
        } catch (_) {/* 已存在 */}

        this._store = null;
        this._folder = this._resolveFolder();
        this._store = new Lib.MetadataStore(this._folder);

        this._panelIcon = new St.Icon({
            icon_name: 'image-x-generic-symbolic',
            style_class: 'system-status-icon',
        });
        this._panelLabel = new St.Label({
            style_class: 'bwf-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
            text: '',
        });
        this._panelLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this._applyPanelMaxWidth();
        this._panelBox = new St.BoxLayout({style_class: 'bwf-panel-box'});
        this._panelBox.add_child(this._panelIcon);
        this._panelBox.add_child(this._panelLabel);
        this.add_child(this._panelBox);

        this._buildMenu();
        this._updatePanelVisible();
        this._connectSignals();
        this._initFolderAndMonitor().catch(e =>
            logInfo(`文件夹初始化失败: ${e}`));
        this._scheduleIdle(INITIAL_DELAY_SECONDS, () => this._startup());
        this._timeouts.add(GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS, () => {
                this._maybeDailyRefresh();
                return GLib.SOURCE_CONTINUE;
            }));
    }

    // -- 生命周期 -----------------------------------------------------------

    _connectSignals() {
        const s = this._settings;
        this._signals.push(
            s.connect('changed::wallpaper-folder', () => {
                this._initFolderAndMonitor().catch(e =>
                    logInfo(`切换壁纸目录失败: ${e}`));
            }),
            s.connect('changed::panel-show-title', () => this._updatePanelVisible()),
            s.connect('changed::panel-max-width', () => this._applyPanelMaxWidth()),
            s.connect('changed::page-size', () => this._rebuildList()),
        );
        this._menuSignal = this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._populateVisibleThumbs();
            else
                this._releaseThumbs();
        });
    }

    _resolveFolder() {
        let folder = this._settings.get_string('wallpaper-folder');
        if (!folder)
            folder = GLib.build_filenamev([GLib.get_home_dir(), 'Pictures', 'BingWallpaper']);
        else
            folder = folder.replace('~', GLib.get_home_dir());
        if (!folder.endsWith('/'))
            folder += '/';
        try {
            Gio.File.new_for_path(folder).make_directory_with_parents(null);
        } catch (_) {/* 已存在 */}
        return folder;
    }

    async _initFolderAndMonitor() {
        this._folder = this._resolveFolder();
        this._store = new Lib.MetadataStore(this._folder);
        await this._store.load();

        if (this._monitor) {
            if (this._monitorSignal) {
                this._monitor.disconnect(this._monitorSignal);
                this._monitorSignal = 0;
            }
            this._monitor.cancel();
            this._monitor = null;
        }
        this._monitor = Gio.File.new_for_path(this._folder).monitor_directory(
            Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitorSignal = this._monitor.connect('changed', (_m, file) => {
            // 写 sidecar 元数据会触发本目录事件，过滤掉避免重载循环
            if (file && file.get_basename() === Lib.METADATA_FILENAME)
                return;
            this._onFolderChanged();
        });
        this._reloadLibrary();
    }

    async _startup() {
        // 一次性导入旧扩展 dconf 元数据（schema 还在时才有机会）
        if (!this._settings.get_boolean('neffo-imported')) {
            const r = await Lib.importNeffoMetadata(
                this._store, this._folder,
                () => this._settings.set_boolean('neffo-imported', true));
            if (r.ok && r.added)
                logInfo(`从旧 BingWallpaper 扩展导入 ${r.added} 条元数据`);
            else if (!r.ok && r.reason !== 'schema-missing')
                logInfo(`旧元数据导入未执行: ${r.reason}`);
        }
        await this._reloadLibrary();
        this._restoreCurrent();
        this._maybeDailyRefresh();
    }

    destroy() {
        for (const sid of this._signals)
            this._settings?.disconnect(sid);
        this._signals = [];
        if (this._menuSignal) {
            this.menu.disconnect(this._menuSignal);
            this._menuSignal = 0;
        }
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        for (const id of this._idleSources)
            GLib.source_remove(id);
        this._idleSources.clear();
        if (this._thumbLoaderId) {
            GLib.source_remove(this._thumbLoaderId);
            this._thumbLoaderId = null;
        }
        if (this._monitor) {
            if (this._monitorSignal) {
                this._monitor.disconnect(this._monitorSignal);
                this._monitorSignal = 0;
            }
            this._monitor.cancel();
            this._monitor = null;
        }
        if (this._debounceId) {
            clearTimeout(this._debounceId);
            this._debounceId = null;
        }
        this._thumbQueue.length = 0;
        this._thumbCache.clear();
        if (this._memMonitor && this._memSignal) {
            try {
                this._memMonitor.disconnect(this._memSignal);
            } catch (_) {}
            this._memSignal = 0;
            this._memMonitor = null;
        }
        // 显式销毁菜单内自建的 widget（super.destroy() 也会随菜单回收，
        // 这里先断开引用，确保 GObject 立即释放并满足静态生命周期检查）
        this._headerImage?.destroy();
        this._headerImage = null;
        this._headerTitle?.destroy();
        this._headerTitle = null;
        this._headerMeta?.destroy();
        this._headerMeta = null;
        this._searchEntry?.destroy();
        this._searchEntry = null;
        this._listSection?.destroy();
        this._listSection = null;
        this._scroll?.destroy();
        this._scroll = null;
        this._statusItem?.destroy();
        this._statusItem = null;
        try {
            this._http.abort();
        } catch (_) {}
        this._http = null;
        this._store = null;
        this._settings = null;
        super.destroy();
    }

    _scheduleIdle(seconds, cb) {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timeouts.delete(id);
            cb.call(this);
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    // -- 菜单结构 -----------------------------------------------------------

    _buildMenu() {
        // 头部：大缩略图 + 标题 + 版权（GNOME 51 移除了 St.Image，用 St.Widget + content）
        this._headerImage = new St.Widget({style_class: 'bwf-header-image'});
        this._headerImage.set_width(HEADER_THUMB_W);
        this._headerImage.set_height(HEADER_THUMB_H);
        this._headerTitle = new St.Label({
            style_class: 'bwf-header-title',
            x_expand: true,
            text: '加载中…',
        });
        this._headerTitle.clutter_text.set_line_wrap(true);
        this._headerMeta = new St.Label({
            style_class: 'bwf-header-meta',
            x_expand: true,
            text: '',
        });
        this._headerMeta.clutter_text.set_line_wrap(true);
        const headerBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'bwf-header-box',
        });
        headerBox.add_child(this._headerImage);
        headerBox.add_child(this._headerTitle);
        headerBox.add_child(this._headerMeta);
        const headerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false, style_class: 'bwf-header-item',
        });
        headerItem.add_child(headerBox);
        this.menu.addMenuItem(headerItem);

        // 控制按钮行
        const controls = [
            ['go-previous-symbolic', '上一张', () => this._step(-1)],
            ['media-playlist-shuffle-symbolic', '随机', () => this._random()],
            ['go-next-symbolic', '下一张', () => this._step(1)],
            ['view-refresh-symbolic', '立即刷新', () => this._refresh()],
            ['folder-symbolic', '打开壁纸目录', () => this._openFolder()],
            ['preferences-system-symbolic', '设置', () => this._extension.openPreferences()],
        ];
        const ctrlBox = new St.BoxLayout({style_class: 'bwf-controls'});
        this._ctrlButtons = new Map();
        for (const [icon, tip, cb] of controls) {
            const btn = new St.Button({
                style_class: 'bwf-icon-button',
                reactive: true, can_focus: true, track_hover: true,
                accessible_name: tip,
                child: new St.Icon({icon_name: icon, icon_size: 16}),
            });
            btn.connect('clicked', cb);
            this._ctrlButtons.set(icon, btn);
            ctrlBox.add_child(btn);
        }
        const ctrlItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false,
        });
        ctrlItem.add_child(ctrlBox);
        this.menu.addMenuItem(ctrlItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 搜索（GNOME 51 移除了 PopupEntry，用 St.Entry 自绘，45+ 通用）
        this._searchEntry = new St.Entry({
            hint_text: '搜索标题 / 日期 / 文件名…',
            style_class: 'bwf-search-entry',
            can_focus: true,
            x_expand: true,
        });
        const searchItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false, style_class: 'bwf-search-item',
        });
        searchItem.add_child(this._searchEntry);
        this._searchEntry.clutter_text.connect('text-changed', () => {
            this._filter = this._searchEntry.clutter_text.get_text() || '';
            this._page = 0;
            this._rebuildList();
        });
        this.menu.addMenuItem(searchItem);

        // 可滚动列表
        this._listSection = new PopupMenu.PopupMenuSection();
        this._scroll = new St.ScrollView({
            style_class: 'bwf-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._scroll.add_child(this._listSection.actor);
        const scrollItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false, style_class: 'bwf-scroll-item',
        });
        scrollItem.add_child(this._scroll);
        this.menu.addMenuItem(scrollItem);

        this._statusItem = new PopupMenu.PopupMenuItem('', {
            reactive: false, can_focus: false, style_class: 'bwf-status',
        });
        this.menu.addMenuItem(this._statusItem);
    }

    // -- 列表渲染 -----------------------------------------------------------

    async _reloadLibrary() {
        try {
            this._entries = await Lib.buildLibrary(this._folder, this._store);
        } catch (e) {
            logInfo(`扫描目录失败: ${e}`);
            this._entries = [];
        }
        this._page = 0;
        this._rebuildList();
        if (this._currentName)
            this._updateHeader(this._entries.find(e => e.name === this._currentName));
    }

    _filteredEntries() {
        const q = this._filter.trim().toLowerCase();
        if (!q)
            return this._entries;
        return this._entries.filter(e =>
            `${e.title} ${e.name} ${e.dateLabel} ${e.copyright}`.toLowerCase().includes(q));
    }

    _rebuildList() {
        this._listSection.removeAll();
        this._thumbQueue.length = 0;
        const all = this._filteredEntries();
        const pageSize = this._settings.get_int('page-size');
        const shown = all.slice(0, (this._page + 1) * pageSize);

        for (const entry of shown)
            this._listSection.addMenuItem(this._makeRow(entry));

        if (all.length > shown.length) {
            const more = new PopupMenu.PopupMenuItem(
                `加载更多（剩余 ${all.length - shown.length} 张）`,
                {style_class: 'bwf-load-more'});
            more.connect('activate', () => {
                this._page++;
                this._rebuildList();
            });
            this._listSection.addMenuItem(more);
        }

        const metaCount = this._entries.filter(e => e.source === 'bing').length;
        this._statusItem.label.text =
            `共 ${this._entries.length} 张 · 带 Bing 元数据 ${metaCount} 张` +
            (this._filter ? ` · 匹配 ${all.length} 张` : '');

        // 菜单关闭时只建占位行，缩略图等打开时再按需加载
        if (this.menu.isOpen)
            this._populateVisibleThumbs();
    }

    _makeRow(entry) {
        const item = new PopupMenu.PopupBaseMenuItem({style_class: 'bwf-row'});
        const thumb = new St.Widget({
            style_class: 'bwf-row-thumb',
            width: ROW_THUMB_W, height: ROW_THUMB_H,
        });
        const placeholder = new St.Icon({
            icon_name: 'image-x-generic-symbolic', icon_size: 24,
            style_class: 'bwf-row-placeholder',
        });
        placeholder.set_position(
            Math.round((ROW_THUMB_W - 24) / 2),
            Math.round((ROW_THUMB_H - 24) / 2));
        thumb.add_child(placeholder);

        const title = new St.Label({
            text: entry.title, x_expand: true,
            style_class: 'bwf-row-title',
        });
        title.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        const sub = new St.Label({
            text: [entry.dateLabel, entry.copyright].filter(Boolean).join(' · '),
            style_class: 'bwf-row-sub',
        });
        sub.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        const textBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, x_expand: true,
        });
        textBox.add_child(title);
        textBox.add_child(sub);

        const check = new St.Icon({
            icon_name: 'object-select-symbolic', icon_size: 16,
            style_class: 'bwf-row-check',
        });
        check.visible = entry.name === this._currentName;

        item.add_child(thumb);
        item.add_child(textBox);
        item.add_child(check);
        item.connect('activate', () => this._select(entry));
        // 按需加载：作业信息挂在行上，菜单打开时统一入队
        item._bwfThumb = thumb;
        item._bwfJob = {path: entry.path, name: entry.name,
            w: ROW_THUMB_W, h: ROW_THUMB_H};
        return item;
    }

    // -- 缩略图（按需加载 + 内存 LRU + 磁盘 PNG 缓存，idle 分批解码） -------

    _placeholderIcon(iconSize) {
        const icon = new St.Icon({
            icon_name: 'image-x-generic-symbolic', icon_size: iconSize,
            style_class: 'bwf-row-placeholder',
        });
        return icon;
    }

    // 菜单打开 / 列表重建（菜单开着）时调用：只给仍是占位符的行排队解码
    _populateVisibleThumbs() {
        for (const item of this._listSection._getMenuItems()) {
            if (!item._bwfJob || !item._bwfThumb)
                continue;
            if (item._bwfThumb.content)
                continue; // 已加载
            this._enqueueThumb(
                item._bwfThumb, item._bwfJob.path, item._bwfJob.name,
                item._bwfJob.w, item._bwfJob.h);
        }
        // 头部大图：关闭期间错过的解码在此补上
        if (this._headerEntry && !this._headerImage.content)
            this._loadHeaderImage(this._headerEntry);
    }

    // 菜单关闭 / 内存紧张时调用：卸载全部 image content，原生内存随 GObject
    // 引用计数归零立即释放；磁盘 PNG 缓存保留，下次打开仅需廉价的小图重解码
    _releaseThumbs() {
        this._thumbQueue.length = 0;
        if (this._thumbLoaderId) {
            GLib.source_remove(this._thumbLoaderId);
            this._idleSources.delete(this._thumbLoaderId);
            this._thumbLoaderId = null;
        }
        this._thumbCache.clear();
        for (const item of this._listSection._getMenuItems()) {
            const thumb = item._bwfThumb;
            if (!thumb || !thumb.content)
                continue;
            thumb.content = null;
            thumb.remove_all_children();
            const ph = this._placeholderIcon(24);
            ph.set_position(
                Math.round((ROW_THUMB_W - 24) / 2),
                Math.round((ROW_THUMB_H - 24) / 2));
            thumb.add_child(ph);
        }
        if (this._headerImage.content) {
            this._headerImage.content = null;
            this._headerImage.remove_all_children();
            const ph = this._placeholderIcon(64);
            ph.set_position(
                Math.round((HEADER_THUMB_W - 64) / 2),
                Math.round((HEADER_THUMB_H - 64) / 2));
            this._headerImage.add_child(ph);
        }
    }

    _onMemoryPressure(level) {
        // LOW(50) 忽略；MEDIUM(100) 清空内存缓存（磁盘 PNG 仍在）；
        // CRITICAL(255) 菜单关闭时连 widget 上的 content 一并卸载
        if (level < Gio.MemoryMonitorWarningLevel.MEDIUM)
            return;
        this._thumbCache.clear();
        if (level >= Gio.MemoryMonitorWarningLevel.CRITICAL && !this.menu.isOpen)
            this._releaseThumbs();
    }

    _enqueueThumb(image, path, name, w, h) {
        this._thumbQueue.push({image, path, name, w, h});
        this._ensureThumbLoader();
    }

    _ensureThumbLoader() {
        if (this._thumbLoaderId)
            return;
        this._thumbLoaderId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            let budget = THUMBS_PER_IDLE;
            while (budget-- > 0 && this._thumbQueue.length) {
                const job = this._thumbQueue.shift();
                if (!job.image.get_parent())
                    continue; // 行已被销毁
                const content = this._loadThumbContent(job);
                if (content) {
                    job.image.remove_all_children();
                    job.image.content = content;
                }
            }
            if (!this._thumbQueue.length) {
                this._idleSources.delete(this._thumbLoaderId);
                this._thumbLoaderId = null;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._idleSources.add(this._thumbLoaderId);
    }

    _loadThumbContent({path, name, w, h}) {
        const cacheKey = `${name}@${w}x${h}`;
        if (this._thumbCache.has(cacheKey))
            return this._thumbCache.get(cacheKey);
        try {
            const thumbPath = GLib.build_filenamev(
                [this._cacheDir, `${name}.png`]);
            let pixbuf;
            if (Gio.File.new_for_path(thumbPath).query_exists(null)) {
                pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(thumbPath, w, h);
            } else {
                pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, w, h);
                try {
                    pixbuf.savev(thumbPath, 'png', [], []);
                } catch (_) {/* 缓存写失败不影响使用 */}
            }
            const content = contentFromPixbuf(pixbuf);
            if (this._thumbCache.size > THUMB_CACHE_MAX)
                this._thumbCache.delete(this._thumbCache.keys().next().value);
            this._thumbCache.set(cacheKey, content);
            return content;
        } catch (e) {
            return null;
        }
    }

    // -- 选中 / 切换 --------------------------------------------------------

    _restoreCurrent() {
        let entry = null;
        const last = this._settings.get_string('last-image');
        if (last)
            entry = this._entries.find(e => e.name === last);
        if (!entry) {
            try {
                const uri = new Gio.Settings({schema: 'org.gnome.desktop.background'})
                    .get_string('picture-uri');
                const base = decodeURIComponent(uri.replace(/^file:\/\//, '').split('/').pop() || '');
                entry = this._entries.find(e => e.name === base);
            } catch (_) {}
        }
        if (!entry)
            entry = this._entries[0] || null;
        if (entry) {
            this._currentName = entry.name;
            this._updateHeader(entry);
            this._updatePanelVisible();
            this._rebuildList();
            // 登录/启动主动应用壁纸（可在设置中关闭）
            if (this._settings.get_boolean('apply-on-startup'))
                this._ensureBackground(entry);
        }
    }

    // 启动恢复：桌面壁纸不是目标图时才写入，幂等且不闪烁；不触发菜单/通知
    _ensureBackground(entry) {
        try {
            const uri = `file://${entry.path}`;
            const bg = new Gio.Settings({schema: 'org.gnome.desktop.background'});
            if (bg.get_string('picture-uri') === uri)
                return; // 已是目标壁纸，跳过
            this._writeBackgroundUri(uri);
            this._settings.set_string('last-image', entry.name);
            logInfo(`启动时应用壁纸: ${entry.name}`);
        } catch (e) {
            logInfo(`启动应用壁纸失败: ${e}`);
        }
    }

    // 纯壁纸写入：桌面（明/暗）+ 可选锁屏，无交互判断、无 toggle 语义
    _writeBackgroundUri(uri) {
        const bg = new Gio.Settings({schema: 'org.gnome.desktop.background'});
        bg.set_string('picture-uri', uri);
        try {
            bg.set_string('picture-uri-dark', uri);
        } catch (_) {}
        try {
            bg.set_string('picture-options', 'zoom');
        } catch (_) {}
        Gio.Settings.sync();

        if (this._settings.get_boolean('set-lockscreen')) {
            const ss = new Gio.Settings({schema: 'org.gnome.desktop.screensaver'});
            ss.set_string('picture-uri', uri);
            try {
                ss.set_string('picture-options', 'zoom');
            } catch (_) {}
        }
    }

    _select(entry) {
        if (!entry)
            return;
        try {
            this._writeBackgroundUri(`file://${entry.path}`);
        } catch (e) {
            logInfo(`设置壁纸失败: ${e}`);
            Main.notify('Bing Wallpaper Folder', `设置壁纸失败: ${e}`);
            return;
        }
        this._currentName = entry.name;
        this._settings.set_string('last-image', entry.name);
        this._updateHeader(entry);
        this._updatePanelVisible();
        this._rebuildList();
    }

    _step(delta) {
        if (!this._entries.length)
            return;
        const idx = this._entries.findIndex(e => e.name === this._currentName);
        const next = this._entries[(idx + delta + this._entries.length) % this._entries.length];
        this._select(next);
    }

    _random() {
        if (this._entries.length < 2)
            return;
        let pick;
        do {
            pick = this._entries[GLib.random_int_range(0, this._entries.length)];
        } while (pick.name === this._currentName);
        this._select(pick);
    }

    _updateHeader(entry) {
        this._headerEntry = entry;
        if (!entry) {
            this._headerTitle.set_text('壁纸目录为空');
            this._headerMeta.set_text(this._folder);
            this._panelLabel.set_text('');
            return;
        }
        this._headerTitle.set_text(entry.title);
        const bits = [entry.dateLabel];
        if (entry.resolution)
            bits.push(entry.resolution);
        if (entry.copyright)
            bits.push(entry.copyright);
        this._headerMeta.set_text(bits.filter(Boolean).join(' · '));
        this._panelLabel.set_text(entry.title);
        // 菜单关闭时只更新文字，图片等打开时再解码（按需）
        if (this.menu.isOpen)
            this._loadHeaderImage(entry);
        else if (!this._headerImage.content) {
            this._headerImage.remove_all_children();
            const ph = this._placeholderIcon(64);
            ph.set_position(
                Math.round((HEADER_THUMB_W - 64) / 2),
                Math.round((HEADER_THUMB_H - 64) / 2));
            this._headerImage.add_child(ph);
        }
    }

    _loadHeaderImage(entry) {
        this._headerImage.remove_all_children();
        this._headerImage.content = null;
        const hid = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleSources.delete(hid);
            try {
                const pb = GdkPixbuf.Pixbuf.new_from_file_at_size(
                    entry.path, HEADER_THUMB_W, HEADER_THUMB_H);
                this._headerImage.content = contentFromPixbuf(pb);
            } catch (_) {
                const errIcon = this._placeholderIcon(64);
                errIcon.set_position(
                    Math.round((HEADER_THUMB_W - 64) / 2),
                    Math.round((HEADER_THUMB_H - 64) / 2));
                this._headerImage.remove_all_children();
                this._headerImage.add_child(errIcon);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._idleSources.add(hid);
    }

    _updatePanelVisible() {
        this._panelLabel.visible = this._settings.get_boolean('panel-show-title');
    }

    _applyPanelMaxWidth() {
        this._panelLabel.set_style(
            `max-width: ${this._settings.get_int('panel-max-width')}px;`);
    }

    // -- 每日拉取 -----------------------------------------------------------

    _maybeDailyRefresh() {
        if (!this._settings.get_boolean('auto-update'))
            return;
        const today = Lib.today8();
        if (this._settings.get_string('last-fetch') !== today)
            this._refresh();
    }

    async _refresh() {
        if (this._refreshing)
            return;
        this._refreshing = true;
        const refreshBtn = this._ctrlButtons.get('view-refresh-symbolic');
        refreshBtn?.get_child()?.set_icon_name('emblem-synchronizing-symbolic');
        try {
            const market = this._settings.get_string('market');
            const resolution = this._settings.get_string('resolution') || 'UHD';
            const archive = await Bing.fetchArchive(this._http, market, 8);
            let downloaded = 0;
            let newest = null;

            for (const img of archive.images) {
                if (!img.startdate || !img.urlbase)
                    continue;
                const name = Bing.filenameFor(img, resolution);
                this._store.set(name, {
                    title: img.title || '',
                    copyright: img.copyright || '',
                    copyrightlink: img.copyrightlink || '',
                    date: img.startdate,
                    urlbase: img.urlbase,
                    market: market === 'auto' ? '' : market,
                    source: 'bing',
                });
                const file = Gio.File.new_for_path(this._folder + name);
                if (!file.query_exists(null)) {
                    await Bing.download(
                        this._http, Bing.imageUrl(img.urlbase, resolution), file);
                    downloaded++;
                }
                if (!newest || img.startdate > newest.img.startdate)
                    newest = {img, name};
            }
            await this._store.save();
            this._settings.set_string('last-fetch', Lib.today8());
            await this._reloadLibrary();

            if (newest && this._settings.get_boolean('auto-update')) {
                const cur = this._entries.find(e => e.name === this._currentName);
                if (!cur || newest.img.startdate > (cur.date8 || '')) {
                    const target = this._entries.find(e => e.name === newest.name);
                    if (target)
                        this._select(target);
                }
            }
            if (downloaded && this._settings.get_boolean('notify'))
                Main.notify('Bing Wallpaper Folder', `已下载 ${downloaded} 张新壁纸`);
        } catch (e) {
            logInfo(`刷新失败: ${e}`);
            Main.notify('Bing Wallpaper Folder', `刷新失败: ${e}`);
            this._scheduleIdle(3600, () => this._refresh());
        } finally {
            refreshBtn?.get_child()?.set_icon_name('view-refresh-symbolic');
            this._refreshing = false;
        }
    }

    // -- 其它 ---------------------------------------------------------------

    _openFolder() {
        try {
            Gio.AppInfo.launch_default_for_uri_async(
                Gio.File.new_for_path(this._folder).get_uri(), null, null, null);
        } catch (e) {
            logInfo(`打开目录失败: ${e}`);
        }
    }

    _onFolderChanged() {
        if (this._debounceId)
            clearTimeout(this._debounceId);
        this._debounceId = setTimeout(() => {
            this._debounceId = null;
            this._reloadLibrary();
        }, MONITOR_DEBOUNCE_MS);
    }
});

export default class BingFolderExtension extends Extension {
    enable() {
        this._indicator = new BingFolderIndicator(this);
        Main.panel.addToStatusArea('bing-wallpaper-folder', this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
