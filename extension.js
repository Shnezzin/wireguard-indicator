/*
 * wireguard-indicator@atareao.es
 *
 * Copyright (c) 2020 Lorenzo Carbonell Cerezo <a.k.a. atareao>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

imports.gi.versions.Gtk = "3.0";
imports.gi.versions.Gdk = "3.0";
imports.gi.versions.Gio = "2.0";
imports.gi.versions.Clutter = "1.0";
imports.gi.versions.St = "1.0";
imports.gi.versions.GObject = "3.0";
imports.gi.versions.GLib = "2.0";

const {Gtk, Gdk, Gio, Clutter, St, GObject, GLib} = imports.gi;

const MessageTray = imports.ui.messageTray;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const ByteArray = imports.byteArray;

const ExtensionUtils = imports.misc.extensionUtils;
const Extension = ExtensionUtils.getCurrentExtension();
const Convenience = Extension.imports.convenience;

const Gettext = imports.gettext.domain(Extension.uuid);
const _ = Gettext.gettext;

var button;

function notify(msg, details, icon='tasker') {
    let source = new MessageTray.Source(Extension.uuid, icon);
    Main.messageTray.add(source);
    let notification = new MessageTray.Notification(source, msg, details);
    notification.setTransient(true);
    source.notify(notification);
}

function getNMCliServices(){
    const services = [];
    try {
        let [, stdout, stderr, status] = GLib.spawn_command_line_sync('nmcli c show');

        if (status !== 0) {
            if (stderr instanceof Uint8Array)
                stderr = ByteArray.toString(stderr);

            throw new Error(stderr);
        }

        if (stdout instanceof Uint8Array)
            stdout = ByteArray.toString(stdout);

        // Now were done blocking the main loop, phewf!
        const lines = stdout.split('\n');
        const name_length = lines[0].indexOf('UUID');
        const uuid_length = lines[0].indexOf('TYPE');
        const type_length = lines[0].indexOf('DEVICE');
        for(let i = 1; i < lines.length; i++){
            const name = lines[i].substring(0, name_length).trim();
            const uuid = lines[i].substring(name_length, uuid_length).trim();
            const type = lines[i].substring(uuid_length, type_length).trim();
            if(type == "wireguard"){
                services.push(`${name}|${uuid}`);
            }
        }
    } catch (e) {
        logError(e);
    }
    return services;
}

var WireGuardIndicator = GObject.registerClass(
    class WireGuardIndicator extends PanelMenu.Button{
        _init(){
            super._init(St.Align.START);
            this._settings = Convenience.getSettings();
            this._isActive = null;

            /* Icon indicator */
            let theme = Gtk.IconTheme.get_default();
            if (theme == null) {
                // Workaround due to lazy initialization on wayland
                // as proposed by @fmuellner in GNOME mutter issue #960
                theme = new Gtk.IconTheme();
                theme.set_custom_theme(St.Settings.get().gtk_icon_theme);
            }
            theme.append_search_path(
                Extension.dir.get_child('icons').get_path());

            let box = new St.BoxLayout();
            let label = new St.Label({text: 'Button',
                                      y_expand: true,
                                      y_align: Clutter.ActorAlign.CENTER });
            //box.add(label);
            this.icon = new St.Icon({style_class: 'system-status-icon'});
            box.add(this.icon);
            this.add_child(box);
            /* Start Menu */
            this.wireGuardSwitch = new PopupMenu.PopupSwitchMenuItem(
                _('Wireguard status'),
                {active: true});
            //this.menu.addMenuItem(this.wireGuardSwitch);
            this.services_section = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this.services_section);
            /* Separator */
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            /* Setings */
            this.settingsMenuItem = new PopupMenu.PopupMenuItem(_("Settings"));
            this.settingsMenuItem.connect('activate', () => {
                ExtensionUtils.openPrefs();
            });
            this.menu.addMenuItem(this.settingsMenuItem);
            /* Init */
            this._sourceId = 0;
            this._settingsChanged();
            this._settings.connect('changed',
                                   this._settingsChanged.bind(this));
        }
        _loadConfiguration(){
            this._usenmcli = this._getValue('nmcli');
            if(this._usenmcli){
                this._services = getNMCliServices();
            }else{
                this._services = this._getValue('services');
            }
            this._usesudo = this._getValue('sudo');
            this._checktime = this._getValue('checktime');
            if(this._checktime < 5){
                this._checktime = 5;
            }else if (this._checktime > 600){
                this._checktime = 600;
            }
            this._darkthem = this._getValue('darktheme')
            this._servicesSwitches = [];
            this.services_section.actor.hide();
            if(this.services_section.numMenuItems > 0){
                this.services_section.removeAll();
            }
            this._services.forEach((item, index, array)=>{
                let [name, service] = item.split('|');
                let serviceSwitch = new PopupMenu.PopupSwitchMenuItem(
                    name,
                    {active: false});
                serviceSwitch.label.set_name(service);
                serviceSwitch.connect('toggled', this._toggleSwitch.bind(this)); 
                this._servicesSwitches.push(serviceSwitch);
                this.services_section.addMenuItem(serviceSwitch);
                this.services_section.actor.show();
            });
        }
        _checkStatus(){
            let isActive = false;
            this._servicesSwitches.forEach((serviceSwitch)=>{
                if(serviceSwitch.state){
                    isActive = true;
                    return;
                }
            });
            if(this._isActive == null || this._isActive != isActive){
                this._isActive = isActive;
                this._set_icon_indicator(this._isActive);
            }
        }
        _toggleSwitch(widget, value){
            try {
                let service = widget.label.get_name();
                let command;
                if(this._usenmcli){
                    const setstatus = ((value == true) ? 'up': 'down');
                    command = ['nmcli', 'c', setstatus, 'uuid', service]
                }else{
                    const setstatus = ((value == true) ? 'start': 'stop');
                    command = ['systemctl', setstatus, service];
                    if(this._usesudo){
                        command.unshift('sudo');
                    }
                }
                let proc = Gio.Subprocess.new(
                    command,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
                proc.communicate_utf8_async(null, null, (proc, res) => {
                    try{
                        let [, stdout, stderr] = proc.communicate_utf8_finish(res);
                        this._update();
                    }catch(e){
                        logError(e);
                    }
                });
            } catch (e) {
                logError(e);
            }
        }

        _getValue(keyName){
            return this._settings.get_value(keyName).deep_unpack();
        }

        _update(){
            this._servicesSwitches.forEach((serviceSwitch, index, array)=>{
                let service = serviceSwitch.label.name;
                try{
                    let command;
                    if(this._usenmcli){
                        command = ['nmcli', 'c', 'show', '--active', 'uuid', service];
                    }else{
                        command = ['systemctl', 'status', service];
                    }
                    let proc = Gio.Subprocess.new(
                        command,
                        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                    );
                    proc.communicate_utf8_async(null, null, (proc, res) => {
                        try {
                            let [, stdout, stderr] = proc.communicate_utf8_finish(res);
                            let active;
                            if(this._usenmcli){
                                active = stdout.length > 0;
                            }else{
                                active = (stdout.indexOf('Active: active') > -1);
                            }
                            GObject.signal_handlers_block_by_func(serviceSwitch,
                                                          this._toggleSwitch);
                            serviceSwitch.setToggleState(active);
                            GObject.signal_handlers_unblock_by_func(serviceSwitch,
                                                            this._toggleSwitch);
                            this._checkStatus();
                        } catch (e) {
                            logError(e);
                        }
                    });
                } catch (e) {
                    logError(e);
                }
            });
            return true;
        }

        _set_icon_indicator(active){
            let darktheme = this._getValue('darktheme');
            let theme_string = (darktheme?'dark': 'light');
            let status_string = (active?'active':'paused')
            let icon_string = 'wireguard-' + status_string + '-' + theme_string;
            this.icon.set_gicon(this._get_icon(icon_string));
        }

        _get_icon(icon_name){
            let base_icon = Extension.path + '/icons/' + icon_name;
            let file_icon = Gio.File.new_for_path(base_icon + '.png')
            if(file_icon.query_exists(null) == false){
                file_icon = Gio.File.new_for_path(base_icon + '.svg')
            }
            if(file_icon.query_exists(null) == false){
                return null;
            }
            let icon = Gio.icon_new_for_string(file_icon.get_path());
            return icon;
        }

        _settingsChanged(){
            this._loadConfiguration();
            this._update();
            if(this._sourceId > 0){
                GLib.source_remove(this._sourceId);
            }
            this._sourceId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, this._checktime,
                this._update.bind(this));
        }

        disableUpdate(){
            if(this._sourceId > 0){
                GLib.source_remove(this._sourceId);
            }
        }
    }
);

let wireGuardIndicator;

function init(){
    Convenience.initTranslations();
}

function enable(){
    wireGuardIndicator = new WireGuardIndicator();
    Main.panel.addToStatusArea('wireGuardIndicator', wireGuardIndicator, 0, 'right');
}

function disable() {
    wireGuardIndicator.disableUpdate();
    wireGuardIndicator.destroy();
}
