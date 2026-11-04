"""Bounded, local-only signalling for separately isolated WebView profiles."""
from collections import deque
from threading import Condition
import json
import math
import time

MAX_SCENE_MESSAGE_BYTES = 512 * 1024
SCENE_SETTING_BOOL_KEYS = {'onTop', 'showQueue', 'showGiftRules', 'showCurrent', 'showStats'}
SCENE_SETTING_PANEL_NAMES = ('rules', 'queue', 'current', 'stats')
SCENE_SETTING_PERCENT_KEYS = {panel + suffix for panel in SCENE_SETTING_PANEL_NAMES
                              for suffix in ('X', 'Y', 'Opacity')}
SCENE_SETTING_SCALE_KEYS = {panel + 'Scale' for panel in SCENE_SETTING_PANEL_NAMES}
SCENE_SETTINGS_KEYS = SCENE_SETTING_BOOL_KEYS | SCENE_SETTING_PERCENT_KEYS | SCENE_SETTING_SCALE_KEYS
SNAPSHOT_KEYS = {'lang', 'printed', 'waiting', 'likes', 'comments', 'gifts', 'current', 'queue', 'rules'}
INTERACTION_RULE_NAMES = ('comment', 'join', 'like', 'follow')
RULE_KEYS = {kind + suffix for kind in INTERACTION_RULE_NAMES for suffix in ('Enabled', 'Count', 'Size')} | {
    'giftEnabled', 'giftSize', 'heartCount', 'beerCount', 'lollipopCount', 'otherCount'}


def _exact_keys(value, expected):
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError('bad object fields')


def _boolean(value):
    if type(value) is not bool:
        raise ValueError('bad boolean')


def _integer(value, low=0, high=1000000000):
    if type(value) is not int or not low <= value <= high:
        raise ValueError('bad integer')


def _number(value, low=0, high=100):
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('bad number')


def _string(value, maximum):
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError('bad string')


def _avatar(value):
    _string(value, 65536)
    if len(value.encode('utf-8')) > 65536:
        raise ValueError('avatar too large')


def _size(value):
    if value not in ('small', 'large'):
        raise ValueError('bad avatar size')


def _validate_scene_snapshot(snapshot):
    _exact_keys(snapshot, SNAPSHOT_KEYS)
    if snapshot['lang'] not in ('zh-CN', 'en'):
        raise ValueError('bad language')
    for key in ('printed', 'waiting', 'likes', 'comments', 'gifts'):
        _integer(snapshot[key])
    current = snapshot['current']
    if current is not None:
        _exact_keys(current, {'name', 'avatar', 'score', 'progress', 'status', 'paused'})
        _string(current['name'], 80)
        _avatar(current['avatar'])
        if current['score'] is not None:
            _number(current['score'])
        _number(current['progress'])
        _string(current['status'], 120)
        _boolean(current['paused'])
    queue = snapshot['queue']
    if not isinstance(queue, list) or len(queue) > 5:
        raise ValueError('bad queue')
    for entry in queue:
        _exact_keys(entry, {'name', 'avatar', 'size', 'priority'})
        _string(entry['name'], 80)
        _avatar(entry['avatar'])
        _size(entry['size'])
        _boolean(entry['priority'])
    rules = snapshot['rules']
    _exact_keys(rules, RULE_KEYS)
    for kind in INTERACTION_RULE_NAMES:
        _boolean(rules[kind + 'Enabled'])
        _integer(rules[kind + 'Count'], 1, 10)
        _size(rules[kind + 'Size'])
    _boolean(rules['giftEnabled'])
    _size(rules['giftSize'])
    for key in ('heartCount', 'beerCount', 'lollipopCount', 'otherCount'):
        _integer(rules[key], 1, 10)


class SceneRelay:
    def __init__(self):
        self.condition = Condition()
        self.sequence = 0
        self.events = deque(maxlen=256)

    def publish(self, client, message):
        if not isinstance(client, str) or not 1 <= len(client) <= 80:
            raise ValueError('bad client')
        if not isinstance(message, dict) or not isinstance(message.get('type'), str) or message.get('type') not in {
            'view-request','view-offer','view-answer','view-ice','view-ping',
            'view-ready','view-bye','view-size','view-stats','view-camera',
            'view-camera-request','view-camera-change','workspace-theme',
            'view-settings','view-overlay-state'}:
            raise ValueError('bad message')
        if message['type'] == 'workspace-theme' and message.get('theme') not in ('light', 'dark'):
            raise ValueError('bad theme')
        if message['type'] == 'view-settings':
            _exact_keys(message, {'type', 'settings'})
            _exact_keys(message['settings'], SCENE_SETTINGS_KEYS)
            for key in SCENE_SETTING_BOOL_KEYS:
                _boolean(message['settings'][key])
            for key in SCENE_SETTING_PERCENT_KEYS:
                _integer(message['settings'][key], 0, 100)
            for key in SCENE_SETTING_SCALE_KEYS:
                _integer(message['settings'][key], 60, 160)
        elif message['type'] == 'view-overlay-state':
            _exact_keys(message, {'type', 'snapshot'})
            _validate_scene_snapshot(message['snapshot'])
        try:
            encoded = json.dumps(message, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
            if len(encoded.encode('utf-8')) > MAX_SCENE_MESSAGE_BYTES:
                raise ValueError('scene message too large')
        except (TypeError, OverflowError, RecursionError) as error:
            raise ValueError('scene message must be JSON') from error
        with self.condition:
            if message['type'] == 'view-overlay-state':
                # A frequent snapshot contains repeated avatar data. Retain
                # only this producer's latest state, preserving every other
                # client's state and all WebRTC signalling in sequence order.
                stale = [event for event in self.events
                         if event[1] == client and event[2].get('type') == 'view-overlay-state']
                for event in stale:
                    self.events.remove(event)
            self.sequence += 1
            self.events.append((self.sequence, client, message))
            self.condition.notify_all()

    def poll(self, client, after=None, timeout=15):
        with self.condition:
            if after is None:
                return {'cursor':self.sequence, 'messages':[]}
            deadline = time.monotonic() + timeout
            while self.sequence <= after and time.monotonic() < deadline:
                self.condition.wait(max(0, deadline-time.monotonic()))
            return {'cursor':self.sequence,
                'messages':[m for n,c,m in self.events if n>after and c!=client]}
