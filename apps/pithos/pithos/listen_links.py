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

"""Open listen:// links (melodica-scrobble docs/LISTEN-URI.md).

artist/genre: after the user says yes, play their station from the list or
create it. station: after the user says yes, play it if it is in the list.
Every other target opens on spacegho.st in the browser. Nothing plays without
the user's yes.
"""

import logging

from gi.repository import Gtk

from .listen_uri import parse_listen_uri, web_url
from .util import open_browser


def is_listen_link(arg):
    a = arg.lower()
    return a.startswith(('listen://', 'web+listen://', 'https://spacegho.st/listen/'))


def _message(window, text):
    dialog = Gtk.MessageDialog(
        parent=window, flags=Gtk.DialogFlags.MODAL, type=Gtk.MessageType.INFO,
        buttons=Gtk.ButtonsType.OK, text=text,
    )
    dialog.connect('response', lambda d, r: d.destroy())
    dialog.show()
    return dialog


def _confirm(window, text, on_yes):
    dialog = Gtk.MessageDialog(
        parent=window, flags=Gtk.DialogFlags.MODAL, type=Gtk.MessageType.QUESTION,
        buttons=Gtk.ButtonsType.YES_NO, text=text,
    )

    def on_response(d, response):
        d.destroy()
        if response == Gtk.ResponseType.YES:
            on_yes()

    dialog.connect('response', on_response)
    dialog.show()
    return dialog


def _seed_station(window, target, name):
    wanted = {name.lower(), '{} radio'.format(name.lower())}
    for station in window.pandora.stations:
        if station.name and station.name.lower() in wanted:
            window.station_changed(station)
            return

    def got_results(results):
        items = [r for r in results if r.resultType == target]
        if not items:
            _message(window, _('Pandora has no {} called {}').format(target, name))
            return
        label = (lambda r: r.name) if target == 'artist' else (lambda r: r.stationName)
        exact = [r for r in items if label(r).lower() == name.lower()]
        item = (exact or items)[0]
        window.worker_run(
            'add_station_by_music_id', (item.musicId,), window.station_added,
            _('Creating station...'), user_data=(target, label(item)),
        )

    window.worker_run('search', (name,), got_results, _('Searching...'))


def open_listen_link(window, link):
    """Handle one link; returns the dialog it showed, if any (for tests)."""
    p = parse_listen_uri(link)
    if not p:
        logging.info('Unsupported listen link')
        return _message(window, _("That link isn't supported"))
    target = p['target']
    if target in ('artist', 'genre'):
        name = p['name']
        if not window.have_stations:
            window.pending_listen_link = link
            return None
        return _confirm(window, _('Start {} station?').format(name),
                        lambda: _seed_station(window, target, name))
    if target == 'station':
        if not window.have_stations:
            window.pending_listen_link = link
            return None
        for station in window.pandora.stations:
            if p['station'] in (station.id, station.idToken):
                return _confirm(window, _('Start {} station?').format(station.name),
                                lambda: window.station_changed(station))
        return _message(window, _("That station isn't in your station list"))
    open_browser(web_url(p), window)
    return None
