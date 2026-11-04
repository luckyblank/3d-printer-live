import unittest
import copy
from scene_relay import SceneRelay


def snapshot():
    return {
        'lang': 'zh-CN', 'printed': 2, 'waiting': 3, 'likes': 10, 'comments': 4, 'gifts': 1,
        'current': {'name': '测试观众', 'avatar': '', 'score': None, 'progress': 62.5, 'status': 'printing', 'paused': False},
        'queue': [{'name': '下一位', 'avatar': '', 'size': 'small', 'priority': False}],
        'rules': {'commentEnabled': True, 'commentCount': 1, 'commentSize': 'small',
                  'joinEnabled': True, 'joinCount': 1, 'joinSize': 'small',
                  'likeEnabled': False, 'likeCount': 1, 'likeSize': 'small',
                  'followEnabled': False, 'followCount': 1, 'followSize': 'small',
                  'giftEnabled': True, 'giftSize': 'large', 'heartCount': 1,
                  'beerCount': 2, 'lollipopCount': 3, 'otherCount': 1},
    }


def settings():
    return {'onTop': True, 'showQueue': False, 'showGiftRules': False, 'showCurrent': False, 'showStats': False,
            'rulesX': 0, 'rulesY': 100, 'rulesOpacity': 90, 'rulesScale': 100,
            'queueX': 100, 'queueY': 0, 'queueOpacity': 90, 'queueScale': 100,
            'currentX': 100, 'currentY': 100, 'currentOpacity': 90, 'currentScale': 100,
            'statsX': 0, 'statsY': 0, 'statsOpacity': 90, 'statsScale': 100}


class RelayTests(unittest.TestCase):
    def test_isolated_clients_receive_peer_messages_only(self):
        r=SceneRelay();self.assertEqual(r.poll('main')['cursor'],0)
        r.publish('main',{'type':'view-offer','sdp':{'type':'offer','sdp':'test'}})
        r.publish('view',{'type':'view-answer','sdp':{'type':'answer','sdp':'test'}})
        self.assertEqual([m['type'] for m in r.poll('main',0,0)['messages']],['view-answer'])
        self.assertEqual([m['type'] for m in r.poll('view',0,0)['messages']],['view-offer'])
    def test_new_client_does_not_replay_stale_offer(self):
        r=SceneRelay();r.publish('main',{'type':'view-offer'})
        self.assertEqual(r.poll('new'),{'cursor':1,'messages':[]})
    def test_bounded_history_and_valid_types(self):
        r=SceneRelay()
        for _ in range(300):r.publish('main',{'type':'view-ping'})
        self.assertEqual(len(r.poll('view',0,0)['messages']),256)
        with self.assertRaises(ValueError):r.publish('bad',{'type':'execute'})
    def test_workspace_theme_reaches_isolated_peer_but_not_sender(self):
        r=SceneRelay()
        r.publish('main',{'type':'workspace-theme','theme':'light'})
        r.publish('main',{'type':'workspace-theme','theme':'dark'})
        self.assertEqual(r.poll('scene-profile',0,0)['messages'],[
            {'type':'workspace-theme','theme':'light'},
            {'type':'workspace-theme','theme':'dark'},
        ])
        self.assertEqual(r.poll('main',0,0)['messages'],[])
    def test_workspace_theme_rejects_missing_or_unknown_values(self):
        r=SceneRelay()
        for value in (None,'auto','LIGHT','',True,0,{},[]):
            with self.subTest(theme=value),self.assertRaises(ValueError):
                r.publish('main',{'type':'workspace-theme','theme':value})
        with self.assertRaises(ValueError):r.publish('main',{'type':'workspace-theme'})
        self.assertEqual(r.sequence,0)
    def test_theme_type_is_exact_and_uses_the_same_bounded_history(self):
        r=SceneRelay()
        for kind in ('workspace-color','workspace-theme-update','view-workspace-theme'):
            with self.subTest(kind=kind),self.assertRaises(ValueError):
                r.publish('main',{'type':kind,'theme':'light'})
        for i in range(300):
            r.publish('main',{'type':'workspace-theme','theme':'light' if i%2 else 'dark'})
        messages=r.poll('scene-profile',0,0)['messages']
        self.assertEqual(len(messages),256)
        self.assertEqual(messages[-1],{'type':'workspace-theme','theme':'light'})

    def test_complete_scene_settings_reach_only_the_peer(self):
        relay = SceneRelay()
        self.assertEqual(len(settings()), 21)
        message = {'type': 'view-settings', 'settings': settings()}
        relay.publish('main', message)
        self.assertEqual(relay.poll('viewer', 0, 0)['messages'], [message])
        self.assertEqual(relay.poll('main', 0, 0)['messages'], [])

    def test_settings_require_exact_fields_and_real_booleans(self):
        invalid = [None, {}, {**settings(), 'extra': False}]
        for key in ('onTop', 'showQueue', 'showGiftRules', 'showCurrent', 'showStats'):
            invalid.append({name: value for name, value in settings().items() if name != key})
            for value in (0, 1, 'true', None, [], {}):
                invalid.append({**settings(), key: value})
        relay = SceneRelay()
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                relay.publish('main', {'type': 'view-settings', 'settings': value})
        with self.assertRaises(ValueError):
            relay.publish('main', {'type': 'view-settings', 'settings': settings(), 'extra': True})
        self.assertEqual(relay.sequence, 0)

    def test_all_panel_positions_and_opacities_accept_integer_endpoints_and_default_values(self):
        relay = SceneRelay()
        expected = []
        for panel in ('rules', 'queue', 'current', 'stats'):
            for suffix in ('X', 'Y', 'Opacity'):
                for percent in (0, 100, 90):
                    value = {**settings(), panel + suffix: percent}
                    message = {'type': 'view-settings', 'settings': value}
                    relay.publish('main', message)
                    expected.append(message)
        self.assertEqual(relay.poll('viewer', 0, 0)['messages'], expected)

    def test_all_panel_positions_and_opacities_require_complete_strict_percent_integers(self):
        relay = SceneRelay()
        keys = [panel + suffix for panel in ('rules', 'queue', 'current', 'stats')
                for suffix in ('X', 'Y', 'Opacity')]
        for key in keys:
            for invalid in (-1, 101, 1.5, True, False, '50', None, float('nan'), float('inf'), {}):
                with self.subTest(key=key, invalid=invalid), self.assertRaises(ValueError):
                    relay.publish('main', {'type': 'view-settings', 'settings': {**settings(), key: invalid}})
            with self.subTest(missing=key), self.assertRaises(ValueError):
                relay.publish('main', {'type': 'view-settings', 'settings': {name: value for name, value in settings().items() if name != key}})
        old_keys = ('onTop', 'showQueue', 'showGiftRules', 'showCurrent', 'showStats')
        for keys in (old_keys, (*old_keys, 'rulesX', 'rulesY', 'rulesOpacity')):
            legacy = {key: settings()[key] for key in keys}
            with self.subTest(legacy_fields=len(keys)), self.assertRaises(ValueError):
                relay.publish('main', {'type': 'view-settings', 'settings': legacy})
        self.assertEqual(relay.sequence, 0)

    def test_each_panel_scale_accepts_sixty_to_one_sixty_without_altering_other_preferences(self):
        relay = SceneRelay()
        expected = []
        for panel in ('rules', 'queue', 'current', 'stats'):
            for scale in (60, 100, 160):
                message = {'type': 'view-settings', 'settings': {**settings(), panel + 'Scale': scale}}
                relay.publish('main', message)
                expected.append(message)
        self.assertEqual(relay.poll('viewer', 0, 0)['messages'], expected)

    def test_each_panel_scale_requires_present_strict_integer_in_its_own_range(self):
        relay = SceneRelay()
        for panel in ('rules', 'queue', 'current', 'stats'):
            key = panel + 'Scale'
            for invalid in (0, 59, 161, 100.0, 60.5, True, False, '100', None, float('nan'), float('inf'), {}, []):
                with self.subTest(key=key, invalid=invalid), self.assertRaises(ValueError):
                    relay.publish('main', {'type': 'view-settings', 'settings': {**settings(), key: invalid}})
            with self.subTest(missing=key), self.assertRaises(ValueError):
                relay.publish('main', {'type': 'view-settings', 'settings': {name: value for name, value in settings().items() if name != key}})
        self.assertEqual(relay.sequence, 0)

    def test_snapshot_accepts_bounded_complete_data_and_idle_current(self):
        relay = SceneRelay()
        for current in (snapshot()['current'], None):
            value = snapshot()
            value['current'] = current
            value['lang'] = 'en'
            relay.publish('main', {'type': 'view-overlay-state', 'snapshot': value})
        self.assertEqual(relay.poll('viewer', 0, 0)['messages'], [
            {'type': 'view-overlay-state', 'snapshot': value},
        ])

    def test_join_like_follow_rules_transport_both_sizes_boolean_states_and_count_endpoints(self):
        relay = SceneRelay()
        self.assertEqual(len(snapshot()['rules']), 18)
        for kind in ('join', 'like', 'follow'):
            for enabled in (False, True):
                for count in (1, 10):
                    for size in ('small', 'large'):
                        with self.subTest(kind=kind, enabled=enabled, count=count, size=size):
                            value = snapshot()
                            value['rules'].update({kind + 'Enabled': enabled, kind + 'Count': count, kind + 'Size': size})
                            message = {'type': 'view-overlay-state', 'snapshot': value}
                            cursor = relay.sequence
                            relay.publish('main', message)
                            self.assertEqual(relay.poll('viewer', cursor, 0)['messages'], [message])

    def test_join_like_follow_rules_reject_coerced_booleans_noninteger_counts_and_invalid_sizes(self):
        relay = SceneRelay()
        invalid_values = {
            'Enabled': (0, 1, 'true', 'false', None, [], {}),
            'Count': (-1, 0, 11, 1.0, 1.5, True, False, '1', None, [], {}, float('nan'), float('inf')),
            'Size': ('', 'medium', 'SMALL', None, 1, True, [], {}),
        }
        for kind in ('join', 'like', 'follow'):
            for suffix, invalids in invalid_values.items():
                key = kind + suffix
                for invalid in invalids:
                    value = snapshot()
                    value['rules'][key] = invalid
                    with self.subTest(key=key, invalid=invalid), self.assertRaises(ValueError):
                        relay.publish('main', {'type': 'view-overlay-state', 'snapshot': value})
        self.assertEqual(relay.sequence, 0)

    def test_snapshot_requires_all_eighteen_rule_fields_and_rejects_legacy_nine(self):
        relay = SceneRelay()
        new_keys = [kind + suffix for kind in ('join', 'like', 'follow') for suffix in ('Enabled', 'Count', 'Size')]
        for key in new_keys:
            value = snapshot()
            del value['rules'][key]
            with self.subTest(missing=key), self.assertRaises(ValueError):
                relay.publish('main', {'type': 'view-overlay-state', 'snapshot': value})
        value = snapshot()
        value['rules'] = {key: item for key, item in value['rules'].items() if key not in new_keys}
        self.assertEqual(len(value['rules']), 9)
        with self.assertRaises(ValueError):
            relay.publish('main', {'type': 'view-overlay-state', 'snapshot': value})
        value = snapshot()
        value['rules']['joinSizeExtra'] = 'small'
        with self.assertRaises(ValueError):
            relay.publish('main', {'type': 'view-overlay-state', 'snapshot': value})
        self.assertEqual(relay.sequence, 0)

    def test_snapshot_rejects_extra_fields_and_out_of_bounds_content(self):
        cases = [
            ('language', lambda s: s.update(lang='auto')),
            ('unknown field', lambda s: s.update(unknown=1)),
            ('boolean count', lambda s: s.update(printed=True)),
            ('large counter', lambda s: s.update(likes=1000000001)),
            ('negative counter', lambda s: s.update(waiting=-1)),
            ('noninteger counter', lambda s: s.update(comments=1.5)),
            ('name', lambda s: s['current'].update(name='n' * 81)),
            ('current fields', lambda s: s['current'].update(other=True)),
            ('score', lambda s: s['current'].update(score=101)),
            ('boolean score', lambda s: s['current'].update(score=True)),
            ('nan progress', lambda s: s['current'].update(progress=float('nan'))),
            ('infinite progress', lambda s: s['current'].update(progress=float('inf'))),
            ('status', lambda s: s['current'].update(status='x' * 121)),
            ('paused', lambda s: s['current'].update(paused=1)),
            ('too many queue items', lambda s: s.update(queue=s['queue'] * 6)),
            ('queue fields', lambda s: s['queue'][0].update(other=True)),
            ('queue size', lambda s: s['queue'][0].update(size='medium')),
            ('queue priority', lambda s: s['queue'][0].update(priority=1)),
            ('rule fields', lambda s: s['rules'].update(extra=True)),
            ('rule count', lambda s: s['rules'].update(heartCount=11)),
            ('rule count bool', lambda s: s['rules'].update(commentCount=True)),
            ('rule size', lambda s: s['rules'].update(giftSize='medium')),
            ('rule enabled', lambda s: s['rules'].update(commentEnabled='true')),
        ]
        relay = SceneRelay()
        for name, mutate in cases:
            value = snapshot()
            mutate(value)
            with self.subTest(name=name), self.assertRaises(ValueError):
                relay.publish('main', {'type': 'view-overlay-state', 'snapshot': value})
        self.assertEqual(relay.sequence, 0)

    def test_avatar_byte_limit_and_serialized_message_budget(self):
        relay = SceneRelay()
        value = snapshot()
        prefix = 'data:image/jpeg;base64,'
        value['current']['avatar'] = prefix + 'a' * (65536 - len(prefix))
        relay.publish('main', {'type': 'view-overlay-state', 'snapshot': value})
        self.assertEqual(relay.sequence, 1)
        for oversized in ('a' * 65537, '猫' * 30000):
            value = snapshot()
            value['current']['avatar'] = oversized
            with self.subTest(oversized=len(oversized)), self.assertRaises(ValueError):
                relay.publish('main', {'type': 'view-overlay-state', 'snapshot': value})
        value = snapshot()
        value['queue'] = [copy.deepcopy(value['queue'][0]) for _ in range(5)]
        # Each avatar fits individually, but JSON escaping pushes the total
        # over the budget. The size check must measure serialized UTF-8 bytes.
        for item in [value['current'], *value['queue']]:
            item['avatar'] = '"' * 50000
        with self.assertRaises(ValueError):
            relay.publish('main', {'type': 'view-overlay-state', 'snapshot': value})
        with self.assertRaises(ValueError):
            relay.publish('main', {'type': 'view-offer', 'sdp': 'x' * (512 * 1024)})
        self.assertEqual(relay.sequence, 1)

    def test_frequent_state_replaces_only_its_client_and_keeps_signalling_order(self):
        relay = SceneRelay()
        relay.publish('main', {'type': 'view-overlay-state', 'snapshot': snapshot()})
        offer = {'type': 'view-offer', 'sdp': {'type': 'offer', 'sdp': 'keep'}}
        relay.publish('main', offer)
        peer_state = {'type': 'view-overlay-state', 'snapshot': snapshot()}
        relay.publish('other-main', peer_state)
        ice = {'type': 'view-ice', 'candidate': {'candidate': 'keep'}}
        relay.publish('viewer', ice)
        for value in range(1000):
            state = snapshot()
            state['waiting'] = value
            relay.publish('main', {'type': 'view-overlay-state', 'snapshot': state})
        events = list(relay.events)
        self.assertEqual(len(events), 4)
        self.assertEqual([event[0] for event in events], [2, 3, 4, 1004])
        self.assertEqual(relay.poll('fresh-viewer', 0, 0)['messages'], [offer, peer_state, ice,
                         {'type': 'view-overlay-state', 'snapshot': state}])
        self.assertEqual(relay.poll('fresh-viewer'), {'cursor': 1004, 'messages': []})

    def test_unknown_scene_protocol_names_are_rejected(self):
        relay = SceneRelay()
        for name in ('scene-settings', 'view-setting', 'view-overlay', [], {}):
            with self.subTest(name=name), self.assertRaises(ValueError):
                relay.publish('main', {'type': name, 'settings': settings()})
if __name__=='__main__':unittest.main()
