# -*- coding: utf-8; tab-width: 4; indent-tabs-mode: nil; -*-
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License version 3, as published
# by the Free Software Foundation.
#
# This program is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranties of
# MERCHANTABILITY, SATISFACTORY QUALITY, or FITNESS FOR A PARTICULAR
# PURPOSE.  See the GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License along
# with this program.  If not, see <http://www.gnu.org/licenses/>.

"""Scrobble to spacegho.st or any ListenBrainz-compatible server.

The server URL lives in GSettings (listenbrainz/server-url); the token lives
in the keyring next to the Pandora password and is never logged.
"""

import logging
import os

from gi.repository import GLib, Gtk

from pithos import listenbrainz
from pithos.gobject_worker import GObjectWorker
from pithos.plugin import PithosPlugin
from pithos.util import SecretService

TOKEN_KEY = 'listenbrainz-token'
RETRY_SECONDS = 300


def queue_path():
    return os.path.join(GLib.get_user_data_dir(), 'pithos', 'listenbrainz-queue.json')


def client_version(window):
    app = window.get_application() if window else None
    return getattr(app, 'version', None) or None


class ListenBrainzPlugin(PithosPlugin):
    preference = 'enable_listenbrainz'
    description = _('Scrobble songs to spacegho.st or another ListenBrainz server')

    def on_prepare(self):
        self.worker = GObjectWorker()
        self.client = None
        self.token = None
        self._handlers = []
        self._retry_id = 0
        self.preferences_dialog = ListenBrainzPrefs(self)
        self.prepare_complete()

    def on_enable(self):
        self._handlers = [
            self.window.connect('song-changed', self._on_song_changed),
            self.window.connect('song-ended', self._on_song_ended),
        ]
        self._retry_id = GLib.timeout_add_seconds(RETRY_SECONDS, self._on_retry)
        if self.window.current_song:
            self._on_song_changed(self.window, self.window.current_song)

    def on_disable(self):
        for handler in self._handlers:
            self.window.disconnect(handler)
        self._handlers = []
        if self._retry_id:
            GLib.source_remove(self._retry_id)
            self._retry_id = 0

    # The token is looked up lazily: plugins load before the keyring is unlocked.

    def with_client(self, callback):
        if self.client is not None:
            callback(self.client)
            return

        def got_token(token):
            self.set_token(token, store=False)
            if self.client is not None:
                self.worker.send(self.client.flush, ())
                callback(self.client)

        SecretService.get_account_password(TOKEN_KEY, got_token)

    def set_token(self, token, store=True):
        self.token = (token or '').strip()
        url = self.settings['server-url']
        if self.token:
            self.client = listenbrainz.ListenBrainzClient(
                url, self.token, queue_path=queue_path(),
                client='Pithos', client_version=client_version(self.window),
            )
        else:
            self.client = None
        if store:
            SecretService.set_account_password(None, TOKEN_KEY, self.token, None, label='ListenBrainz token')

    def _metadata(self, client, song):
        station = song.station
        return client.metadata(
            song.artist, song.title,
            album=song.album,
            duration_s=song.get_duration_sec(),
            art_url=song.artRadio,
            station=station.name if station else None,
        )

    def _on_song_changed(self, window, song):
        if song.is_ad:
            return

        def send(client):
            self.worker.send(client.now_playing, (self._metadata(client, song),))

        self.with_client(send)

    def _on_song_ended(self, window, song):
        if song.is_ad or not song.start_time:
            return
        if not listenbrainz.listen_counts(song.get_duration_sec(), song.get_position_sec()):
            return

        def done(result):
            logging.info('ListenBrainz: {} by {}: {}'.format(song.title, song.artist, result))

        def err(e):
            logging.error('ListenBrainz listen failed: {}'.format(type(e).__name__))

        def send(client):
            meta = self._metadata(client, song)
            self.worker.send(client.listen, (meta, int(song.start_time)), done, err)

        self.with_client(send)

    def _on_retry(self):
        if self.client is not None:
            self.worker.send(self.client.flush, ())
        return True


class ListenBrainzPrefs(Gtk.Dialog):
    __gtype_name__ = 'ListenBrainzPrefs'

    def __init__(self, plugin):
        super().__init__(use_header_bar=1)
        self.plugin = plugin
        self.set_title(_('Scrobbling'))
        self.set_default_size(420, -1)
        self.set_resizable(False)
        self.connect('delete-event', self.on_close)
        self.connect('show', self.on_show)

        grid = Gtk.Grid(row_spacing=6, column_spacing=12, margin=12)

        grid.attach(Gtk.Label(label=_('Server'), halign=Gtk.Align.END), 0, 0, 1, 1)
        self.preset = Gtk.ComboBoxText()
        for name, url in listenbrainz.PRESETS:
            self.preset.append(url, name)
        self.preset.append('custom', _('Other server'))
        self.preset.connect('changed', self.on_preset_changed)
        grid.attach(self.preset, 1, 0, 1, 1)

        grid.attach(Gtk.Label(label=_('URL'), halign=Gtk.Align.END), 0, 1, 1, 1)
        self.url = Gtk.Entry(hexpand=True, placeholder_text=listenbrainz.SPACEGHOST_URL)
        grid.attach(self.url, 1, 1, 1, 1)

        grid.attach(Gtk.Label(label=_('Token'), halign=Gtk.Align.END), 0, 2, 1, 1)
        self.token = Gtk.Entry(hexpand=True, visibility=False, input_purpose=Gtk.InputPurpose.PASSWORD)
        grid.attach(self.token, 1, 2, 1, 1)

        hint = Gtk.Label(halign=Gtk.Align.START, wrap=True)
        hint.set_markup(_('Get a spacegho.st token at <a href="{0}">{0}</a>').format(listenbrainz.TOKEN_PAGE))
        grid.attach(hint, 1, 3, 1, 1)

        check = Gtk.Button(label=_('Check token'), halign=Gtk.Align.START)
        check.connect('clicked', self.on_check)
        grid.attach(check, 1, 4, 1, 1)
        self.status = Gtk.Label(halign=Gtk.Align.START, wrap=True)
        grid.attach(self.status, 1, 5, 1, 1)

        self.get_content_area().add(grid)
        self.get_content_area().show_all()

    def on_show(self, *ignore):
        url = listenbrainz.normalize_base(self.plugin.settings['server-url'])
        self.url.set_text(url)
        if not self.preset.set_active_id(url):
            self.preset.set_active_id('custom')
        self.status.set_text('')

        def got_token(token):
            self.token.set_text(token or '')

        SecretService.get_account_password(TOKEN_KEY, got_token)

    def on_preset_changed(self, combo):
        url = combo.get_active_id()
        custom = url == 'custom'
        self.url.set_sensitive(custom)
        if not custom and url:
            self.url.set_text(url)

    def save(self):
        self.plugin.settings['server-url'] = listenbrainz.normalize_base(self.url.get_text())
        self.plugin.set_token(self.token.get_text())

    def on_check(self, *ignore):
        self.save()
        client = self.plugin.client
        if client is None:
            self.status.set_text(_('Enter a token first.'))
            return
        self.status.set_text(_('Checking…'))

        def done(result):
            valid, name = result
            if valid:
                self.status.set_text(_('Token valid for {}.').format(name or _('this account')))
                self.plugin.worker.send(client.flush, ())
            else:
                self.status.set_text(_('The server does not accept this token.'))

        def err(e):
            self.status.set_text(str(e))

        self.plugin.worker.send(client.validate, (), done, err)

    def on_close(self, *ignore):
        self.save()
        self.hide()
        return True
