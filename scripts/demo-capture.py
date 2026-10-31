"""Capture the real picker in a PTY; never accept a selection or launch an agent."""
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 104, 0, 0))
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
data = b''
last = time.monotonic()
deadline = last + 30
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            data += chunk
            last = time.monotonic()
        if b'Continue which chat' in data and time.monotonic() - last > 0.7:
            break
    if b'Continue which chat' not in data:
        raise RuntimeError('Picker did not render: ' + data.decode(errors='replace'))
    sys.stdout.buffer.write(data)
finally:
    process.send_signal(signal.SIGINT)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    os.close(master)
