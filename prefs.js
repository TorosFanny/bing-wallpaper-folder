import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MARKETS = ['auto', 'zh-CN', 'zh-HK', 'zh-TW', 'en-US', 'en-GB', 'en-WW',
    'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'ru-RU', 'pt-BR', 'it-IT'];
const RESOLUTIONS = ['UHD', '1920x1080', '1920x1200', '1366x768', '1280x720'];

export default class BingFolderPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_search_enabled(true);

        // ---- 壁纸来源 -----------------------------------------------------
        const sourceGroup = new Adw.PreferencesGroup({title: '壁纸来源'});

        const folderRow = new Adw.ActionRow({
            title: '壁纸目录',
            subtitle: this._folderSubtitle(settings),
        });
        const pickBtn = new Gtk.Button({
            label: '选择…',
            valign: Gtk.Align.CENTER,
        });
        pickBtn.connect('clicked', () => this._pickFolder(window, settings, folderRow));
        const resetBtn = new Gtk.Button({
            label: '重置',
            valign: Gtk.Align.CENTER,
        });
        resetBtn.connect('clicked', () => {
            settings.set_string('wallpaper-folder', '');
            folderRow.subtitle = this._folderSubtitle(settings);
        });
        folderRow.add_suffix(pickBtn);
        folderRow.add_suffix(resetBtn);
        sourceGroup.add(folderRow);

        const marketRow = new Adw.ComboRow({title: 'Bing 市场'});
        marketRow.model = Gtk.StringList.new(MARKETS);
        marketRow.selected = Math.max(0, MARKETS.indexOf(settings.get_string('market')));
        marketRow.connect('notify::selected', () => {
            settings.set_string('market', MARKETS[marketRow.selected]);
        });
        sourceGroup.add(marketRow);

        const resRow = new Adw.ComboRow({title: '下载分辨率'});
        resRow.model = Gtk.StringList.new(RESOLUTIONS);
        resRow.selected = Math.max(0, RESOLUTIONS.indexOf(settings.get_string('resolution')));
        resRow.connect('notify::selected', () => {
            settings.set_string('resolution', RESOLUTIONS[resRow.selected]);
        });
        sourceGroup.add(resRow);

        // ---- 行为 ---------------------------------------------------------
        const behaviorGroup = new Adw.PreferencesGroup({title: '行为'});
        behaviorGroup.add(this._switchRow(settings, 'auto-update',
            '每日自动拉取并切换最新壁纸'));
        behaviorGroup.add(this._switchRow(settings, 'apply-on-startup',
            '登录/启动时自动应用壁纸'));
        behaviorGroup.add(this._switchRow(settings, 'set-lockscreen',
            '同时设置锁屏壁纸'));
        behaviorGroup.add(this._switchRow(settings, 'notify',
            '新壁纸到达时发送通知'));
        behaviorGroup.add(this._switchRow(settings, 'panel-show-title',
            '在面板显示当前壁纸标题'));

        const widthRow = new Adw.SpinRow({
            title: '面板标题最大宽度（像素）',
            adjustment: new Gtk.Adjustment({
                lower: 60, upper: 600, step_increment: 10, page_increment: 50,
                value: settings.get_int('panel-max-width'),
            }),
        });
        settings.bind('panel-max-width', widthRow.adjustment, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(widthRow);

        const pageRow = new Adw.SpinRow({
            title: '菜单列表每页条数',
            adjustment: new Gtk.Adjustment({
                lower: 20, upper: 500, step_increment: 10, page_increment: 50,
                value: settings.get_int('page-size'),
            }),
        });
        settings.bind('page-size', pageRow.adjustment, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(pageRow);

        // ---- 数据 ---------------------------------------------------------
        const dataGroup = new Adw.PreferencesGroup({title: '元数据'});
        const dataRow = new Adw.ActionRow({
            title: '元数据位置',
            subtitle: `${this._folderSubtitle(settings).replace('（默认）', '')}` +
                '.bing-wallpaper-folder.json（放在壁纸文件夹内，' +
                '与 dconf 解耦，重置 dconf 不丢失）',
        });
        dataGroup.add(dataRow);

        const importRow = new Adw.ActionRow({
            title: '从旧 BingWallpaper 扩展导入',
            subtitle: '把旧扩展写在 dconf 的 bing-json 元数据合并进本扩展',
        });
        const importBtn = new Gtk.Button({
            label: settings.get_boolean('neffo-imported') ? '重新导入' : '导入',
            valign: Gtk.Align.CENTER,
        });
        importBtn.connect('clicked', () => {
            settings.set_boolean('neffo-imported', false);
            importBtn.label = '将在下次加载扩展时执行';
        });
        importRow.add_suffix(importBtn);
        dataGroup.add(importRow);

        const page = new Adw.PreferencesPage();
        page.add(sourceGroup);
        page.add(behaviorGroup);
        page.add(dataGroup);
        window.add(page);
    }

    _switchRow(settings, key, title) {
        const row = new Adw.SwitchRow({title});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _folderSubtitle(settings) {
        const v = settings.get_string('wallpaper-folder');
        if (v)
            return v;
        return GLib.build_filenamev(
            [GLib.get_home_dir(), 'Pictures', 'BingWallpaper']) + '（默认）';
    }

    _pickFolder(window, settings, row) {
        const current = settings.get_string('wallpaper-folder')
            || GLib.build_filenamev([GLib.get_home_dir(), 'Pictures', 'BingWallpaper']);
        const dialog = new Gtk.FileDialog({
            title: '选择壁纸目录',
            initial_folder: Gio.File.new_for_path(current),
            modal: true,
        });
        dialog.select_folder(window, null, (d, result) => {
            try {
                const folder = d.select_folder_finish(result);
                settings.set_string('wallpaper-folder', folder.get_path());
                row.subtitle = this._folderSubtitle(settings);
            } catch (_) {/* 用户取消 */}
        });
    }
}
