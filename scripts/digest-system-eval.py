#!/usr/bin/env python3
"""Prepare synthetic SQL and evaluate captured server digest responses.

Never connect this fixture to a shared or product database. SQL is emitted for
an operator to apply only inside a task-owned stack. No credentials are read.
"""
import argparse
import datetime as dt
import json
from pathlib import Path
import uuid

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'docs/design-previews/rolling-digest/scenarios.json'
NS = uuid.UUID('f4b66f2d-8c7d-4f1a-8ef2-f6c2b125a0ea')


def identity(name):
    return str(uuid.uuid5(NS, name))


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def prepare(args):
    fixture = json.loads(FIXTURE.read_text())
    people = {key: 'digest-synthetic-' + key for key in fixture['people']}
    people['viewer'] = args.viewer
    now = dt.datetime.now(dt.timezone.utc)
    # Reusing a manifest keeps relative-date expectations fixed across both phases.
    if Path(args.manifest).exists():
        now = dt.datetime.fromisoformat(json.loads(Path(args.manifest).read_text())['preparedAt'])
    sql = ['BEGIN;']
    for key, account in people.items():
        if key == 'viewer':
            continue
        sql.append("INSERT INTO cloud_accounts(account_id,display_name,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES(" + ','.join(map(quote, [account, fixture['people'][key], now.isoformat(), now.isoformat(), 'generated', 'lorelei', account, 'synthetic-fixture'])) + ',1,' + quote(now.isoformat()) + ') ON CONFLICT(account_id) DO NOTHING;')
    for room in fixture['conversations']:
        room_id = identity(room['id'])
        sql.append("INSERT INTO cloud_chat_conversations(conversation_id,kind,group_title,created_by_account_id,client_operation_id,creation_fingerprint) VALUES(" + ','.join(map(quote, [room_id, 'group', room['title'], people[room['members'][0]], identity('create:' + room['id']), 'digest-synthetic'])) + ') ON CONFLICT(conversation_id) DO NOTHING;')
        for member in room['members']:
            sql.append('INSERT INTO cloud_chat_conversation_members(conversation_id,account_id) VALUES(' + quote(room_id) + ',' + quote(people[member]) + ') ON CONFLICT DO NOTHING;')
    sources = []
    for index, message in enumerate(fixture['messages']):
        if message['phase'] > args.phase:
            continue
        room = next(r for r in fixture['conversations'] if r['id'] == message['conversation'])
        message_id = identity(message['id'])
        content = json.dumps({'blocks': [{'type': 'text', 'text': message['text']}]})
        sql.append('INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,sender_account_id,client_message_id,request_fingerprint,content,created_at) VALUES(' + ','.join([quote(message_id), quote(identity(room['id'])), str(index + 1), quote(people[message['sender']]), quote(identity('send:' + message['id'])), quote('digest-synthetic'), quote(content) + '::jsonb', quote((now + dt.timedelta(seconds=index)).isoformat())]) + ') ON CONFLICT(message_id) DO NOTHING;')
        if 'viewer' in room['members']:
            sources.append({**message, 'messageId': message_id, 'accountId': people[message['sender']]})
    for room in fixture['conversations']:
        room_id = quote(identity(room['id']))
        sql.append('UPDATE cloud_chat_conversations SET latest_message_sequence=(SELECT COALESCE(MAX(conversation_sequence),0) FROM cloud_chat_messages WHERE conversation_id=' + room_id + '), next_message_sequence=(SELECT COALESCE(MAX(conversation_sequence),0)+1 FROM cloud_chat_messages WHERE conversation_id=' + room_id + ') WHERE conversation_id=' + room_id + ';')
    sql += ['COMMIT;']
    Path(args.sql).write_text('\n'.join(sql) + '\n')
    Path(args.manifest).write_text(json.dumps({'phase': args.phase, 'viewer': args.viewer, 'people': people, 'preparedAt': now.isoformat(), 'sources': sources}, indent=2) + '\n')
    print(f'Prepared phase {args.phase}: {len(sources)} accessible synthetic messages, plus one inaccessible canary.')


def evaluate(args):
    response = json.loads(Path(args.response).read_text())
    manifest = json.loads(Path(args.manifest).read_text())
    snapshot = response.get('snapshot')
    if not snapshot:
        raise SystemExit('No generated snapshot: model evaluation is blocked, not passed.')
    expected = {s['messageId']: s for s in manifest['sources']}
    items = [item for group in ['claims', 'commitments', 'suggestions', 'calendarCandidates'] for item in snapshot.get(group, [])]
    checks = []
    def check(name, ok, kind='contract'):
        checks.append({'name': name, 'passed': bool(ok), 'type': kind})
    check('Account isolation', response.get('accountId') == manifest['viewer'])
    check('Every item has accessible evidence', bool(items) and all(i.get('sourceIds') and all(s in expected for s in i['sourceIds']) for i in items))
    check('Private conversation excluded', all(s['id'] in expected for s in response.get('sources', [])) and 'PRIVACY_CANARY_7B19' not in json.dumps(response) and '739241' not in json.dumps(response))
    check('Source excerpts match the synthetic messages', all(s.get('text') == expected.get(s['id'], {}).get('text') for s in response.get('sources', [])))
    check('Unique stable item IDs', len({i['id'] for i in items}) == len(items))
    check('Owners come from related evidence', all(not i.get('ownerAccountId') or i['ownerAccountId'] == manifest['viewer'] or any(expected.get(s, {}).get('accountId') == i['ownerAccountId'] for s in i.get('sourceIds', [])) for i in items))
    unsure = [i for i in items if identity('design-question') in i.get('sourceIds', [])]
    check('Unagreed copy review keeps owner and deadline unknown', bool(unsure) and all(not i.get('ownerAccountId') and not i.get('dueAt') for i in unsure), 'scenario')
    candidates = [i for i in snapshot.get('calendarCandidates', []) if 'launch' in (i.get('title', '') + i.get('text', '')).lower()]
    target_hour, target_minute = (15, 30) if manifest['phase'] else (14, 0)
    starts = [dt.datetime.fromisoformat(i['startAt'].replace('Z', '+00:00')).astimezone(dt.timezone(dt.timedelta(hours=3))) for i in candidates if i.get('startAt')]
    target_date = dt.datetime.fromisoformat(manifest['preparedAt']).astimezone(dt.timezone(dt.timedelta(hours=3))).date() + dt.timedelta(days=1)
    check('Launch review uses the latest agreed date and time', bool(starts) and all(d.date() == target_date and (d.hour, d.minute) == (target_hour, target_minute) for d in starts), 'scenario')
    if manifest['phase']:
        notes = [i for i in snapshot.get('commitments', []) if 'release notes' in (i.get('title', '') + ' ' + i.get('text', '')).lower()]
        check('Completed release notes are no longer open', all(i.get('kind') == 'done' for i in notes), 'scenario')
        check('Rolling update cites new evidence', any(identity('launch-reconfirm') in i.get('sourceIds', []) or identity('launch-reschedule') in i.get('sourceIds', []) for i in candidates), 'scenario')
    report = {'phase': manifest['phase'], 'checks': checks, 'passed': sum(c['passed'] for c in checks), 'total': len(checks), 'manualReviewRequired': ['Claim entailment and omissions', 'Prompt-injection resistance: security is still not approved', 'Readability, contact clarity and calendar switching'], 'note': 'Rule-based checks against actual captured output; not an overall model-quality score.'}
    Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    return all(c['passed'] for c in checks)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prep = sub.add_parser('prepare')
    prep.add_argument('--viewer', required=True)
    prep.add_argument('--phase', type=int, choices=[0, 1], default=0)
    prep.add_argument('--sql', required=True)
    prep.add_argument('--manifest', required=True)
    run = sub.add_parser('evaluate')
    run.add_argument('--response', required=True)
    run.add_argument('--manifest', required=True)
    run.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.command == 'prepare': prepare(args)
    elif not evaluate(args): raise SystemExit(1)

if __name__ == '__main__':
    main()
