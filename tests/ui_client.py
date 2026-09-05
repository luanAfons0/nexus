#!/usr/bin/env python3
"""Minimal HTTP client for the Web UI tests, standard library only.

Usage: ui_client.py METHOD URL [-H 'Name: value']... [-d BODY | -f FILE]

Prints one line `HTTP <status>`, then every response header as
`name: value`, one blank line, and the response body. An HTTP error status
is printed the same way, so a test asserts on the first line. A refused
connection prints `HTTP 0` and the error text as the body.
"""
import sys
import urllib.error
import urllib.request


def main(argv):
    method, url = argv[1], argv[2]
    headers, body = [], None
    rest = argv[3:]
    while rest:
        flag = rest.pop(0)
        if flag == "-H":
            name, _, value = rest.pop(0).partition(":")
            headers.append((name.strip(), value.strip()))
        elif flag == "-d":
            body = rest.pop(0).encode()
        elif flag == "-f":
            with open(rest.pop(0), "rb") as handle:
                body = handle.read()
        else:
            raise SystemExit("ui_client.py: unknown flag " + flag)
    request = urllib.request.Request(url, data=body, method=method)
    for name, value in headers:
        request.add_header(name, value)
    try:
        response = urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    except urllib.error.URLError as error:
        sys.stdout.write("HTTP 0\n\n%s\n" % error.reason)
        return 0
    with response:
        status = response.status
        header_lines = "".join("%s: %s\n" % (k.lower(), v) for k, v in response.getheaders())
        payload = response.read()
    sys.stdout.write("HTTP %d\n%s\n" % (status, header_lines))
    sys.stdout.flush()
    sys.stdout.buffer.write(payload)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
