#!/usr/bin/env python3
"""Task-owned SSH stdio worker. Reads only the approved dev container's PiP credential."""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def configuration():
    ids = subprocess.run(['sudo', '-n', 'docker', 'ps', '-q', '--filter', 'label=com.docker.compose.service=cloud-server'], capture_output=True, text=True, check=True).stdout.split()
    if not ids:
        raise RuntimeError('Development API container unavailable')
    containers = json.loads(subprocess.run(['sudo', '-n', 'docker', 'inspect', *ids], capture_output=True, text=True, check=True).stdout)
    matches = []
    for container in containers:
        ports = container.get('NetworkSettings', {}).get('Ports', {})
        approved = any(p.get('HostPort') == '17081' and p.get('HostIp') in ('127.0.0.1', '::1') for group in ports.values() for p in (group or []))
        if approved:
            matches.append(dict(item.split('=', 1) for item in container['Config'].get('Env', []) if '=' in item))
    if len(matches) != 1 or not matches[0].get('KORDI_PIP_OPENAI_API_KEY'):
        raise RuntimeError('Unique development PiP configuration unavailable')
    return matches[0]['KORDI_PIP_OPENAI_API_KEY'], matches[0].get('KORDI_PIP_OPENAI_MODEL', '').strip() or 'gpt-5.6-luna'


def emit(value):
    print(json.dumps(value), flush=True)


def main():
    key, model = configuration()
    emit({'ready': True, 'model': model})
    opener = urllib.request.build_opener(NoRedirect())
    for number, line in enumerate(sys.stdin):
        if number >= 64 or len(line) > 256000:
            emit({'status': 400, 'error': 'Benchmark budget exceeded'})
            break
        started = time.monotonic()
        try:
            body = json.loads(line)
            if body.get('model') != model or body.get('stream') is not False:
                emit({'status': 400, 'error': 'Unexpected benchmark model or stream setting'})
                continue
            request = urllib.request.Request('https://api.openai.com/v1/chat/completions',
                data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
            with opener.open(request, timeout=60) as response:
                value = json.loads(response.read(1_000_000))
            # Drop identifiers, headers and provider-specific metadata. Only synthetic model
            # messages, finish reasons and numeric token accounting cross the SSH connection.
            usage = value.get('usage', {})
            result = {'choices': [{'message': c.get('message'), 'finish_reason': c.get('finish_reason')} for c in value.get('choices', [])],
                'usage': {k: usage[k] for k in ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details'] if k in usage}}
            emit({'status': 200, 'body': result, 'providerMs': round((time.monotonic() - started) * 1000)})
        except urllib.error.HTTPError as error:
            emit({'status': error.code, 'error': 'Provider rejected request', 'providerMs': round((time.monotonic() - started) * 1000)})
        except Exception:
            emit({'status': 502, 'error': 'Provider request failed', 'providerMs': round((time.monotonic() - started) * 1000)})


if __name__ == '__main__':
    try:
        main()
    except Exception:
        emit({'ready': False, 'error': 'Development configuration unavailable'})
        raise SystemExit(1)
