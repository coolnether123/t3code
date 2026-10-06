"""Backfill known automatic titles through T3, retaining private undo metadata."""
import argparse
import datetime
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import uuid
from zoneinfo import ZoneInfo

PREFIX = re.compile(r"^(?:0?[1-9]|1[0-2])/(?:0?[1-9]|[12]\d|3[01])\s+")


def plan_titles(db):
    latest = {}
    for sequence, kind, actor, command, payload in db.execute(
        "SELECT sequence,event_type,actor_kind,command_id,payload_json "
        "FROM orchestration_events WHERE event_type IN "
        "('thread.created','thread.meta-updated') ORDER BY sequence"
    ):
        data = json.loads(payload)
        if "title" in data:
            latest[data['threadId']] = (sequence, kind, actor, command, data['title'])
    plan = []
    skipped = {'prefixed': 0, 'manual_or_unknown': 0}
    for thread_id, title, created in db.execute(
        "SELECT thread_id,title,created_at FROM projection_threads WHERE deleted_at IS NULL"
    ):
        if PREFIX.match(title):
            skipped['prefixed'] += 1
            continue
        evidence = latest.get(thread_id)
        if not evidence or evidence[1] != 'thread.meta-updated' or evidence[2] != 'server' or evidence[4] != title:
            skipped['manual_or_unknown'] += 1
            continue
        date = datetime.datetime.fromisoformat(created.replace('Z', '+00:00'))
        if date.tzinfo is None:
            raise ValueError('Creation date lacks a timezone')
        date = date.astimezone(ZoneInfo('America/New_York'))
        plan.append({'thread_id': thread_id, 'before': title,
                     'after': f'{date.month}/{date.day} {title}',
                     'created_at': created, 'title_sequence': evidence[0],
                     'command_id': 'title-date-backfill:'+str(uuid.uuid4())})
    return plan, skipped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-dir', required=True, type=pathlib.Path)
    parser.add_argument('--node', required=True)
    parser.add_argument('--entry', required=True)
    parser.add_argument('--metadata', required=True, type=pathlib.Path)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    db = sqlite3.connect('file:'+str(args.base_dir/'userdata/state.sqlite')+'?mode=ro', uri=True)
    plan, skipped = plan_titles(db)
    if not args.execute:
        print(json.dumps({'planned': len(plan), 'skipped': skipped, 'changed': 0}))
        return

    def call(request):
        result = subprocess.run([args.node, args.entry, 'agent', 'request', '--base-dir', str(args.base_dir)],
                                input=json.dumps(request), capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError('T3 title request failed; reconcile private metadata before retrying')
        return json.loads(result.stdout)

    capabilities = call({'kind': 'capabilities', 'command': 'thread.meta.update'})
    if 'expectedTitle' not in json.dumps(capabilities):
        raise RuntimeError('Running title API does not support the concurrency guard')
    identity = call({'kind': 'snapshot'})
    args.metadata.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(args.metadata, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump({'runtime': identity['runtime'], 'environment_id': identity['environmentId'],
                   'plan': plan, 'skipped': skipped}, file)
        file.flush()
        os.fsync(file.fileno())

    changed = stale = 0
    for item in plan:
        current = db.execute('SELECT title FROM projection_threads WHERE thread_id=?', (item['thread_id'],)).fetchone()
        if current != (item['before'],):
            stale += 1
            continue
        result = call({'kind': 'act', 'confirm': True,
                       'environmentId': identity['environmentId'], 'runtime': identity['runtime'],
                       'command': {'type': 'thread.meta.update', 'commandId': item['command_id'],
                                   'threadId': item['thread_id'], 'expectedTitle': item['before'],
                                   'title': item['after']}})
        current = db.execute('SELECT title FROM projection_threads WHERE thread_id=?', (item['thread_id'],)).fetchone()
        if result.get('status') != 'accepted':
            raise RuntimeError('Title outcome is uncertain; reconcile metadata before retrying')
        if current == (item['after'],):
            changed += 1
        elif current != (item['before'],):
            stale += 1
        else:
            raise RuntimeError('Accepted title was not observed in persisted state')
    remaining, _ = plan_titles(db)
    print(json.dumps({'planned': len(plan), 'changed': changed, 'stale': stale,
                      'skipped': skipped, 'remaining_automatic_unprefixed': len(remaining)}))


if __name__ == '__main__':
    main()
