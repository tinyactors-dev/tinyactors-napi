"""The Python system "py": a tinyactors-cpython host running charts/pong.scxml,
serving one TCP connection from the Node system.

    PYTHONPATH=<tinyactors-cpython>/build/abi3 python python_system.py

It listens on 127.0.0.1 at a port the system picks and writes it as the
first line of its standard output, {"port": N}; every <log> line follows as
{"label": ..., "text": ...}. It stops when its standard input ends.

The wire (README.md, "The wire"): frames of a 4-byte big-endian length and
one CBOR item, each a JSON-RPC 2.0 notification without its "jsonrpc"
member, the shape core's own messages have. "message.send" carries a
send.message as its params; "message.fail" reports a message the receiver
could not deliver, {"sender": <the message's origin>, "sendid": ...}.
"""

import asyncio
import json
import pathlib
import struct
import sys

import tinyactors

SYSTEM = "py"
HEADER = struct.Struct(">I")
MAX_FRAME = 16 * 1024 * 1024


def frame(method, params):
    """One notification, framed: its CBOR (tinyactors.encode) after its length."""
    body = tinyactors.encode({"method": method, "params": params})
    return HEADER.pack(len(body)) + body


def emit(record):
    print(json.dumps(record, ensure_ascii=False), flush=True)


async def main():
    chart = (pathlib.Path(__file__).parent / "charts" / "pong.scxml").read_text(encoding="utf-8")
    peer = {"writer": None}           # the one connection, from the Node system

    def transport(host, send):
        """Every send to another system: the message goes to the peer, or fails."""
        writer = peer["writer"]
        if writer is None or writer.is_closing():
            send.fail()                # no connection: the sender gets error.communication
            return
        writer.write(frame("message.send", send.message))

    def log(host, entry):
        emit({"label": entry.label, "text": entry.text})

    async with tinyactors.Host({"systemID": SYSTEM}, log=log, transport=transport) as host:
        with tinyactors.compile_charts([("pong.scxml", chart)]) as compiled:
            host.add_image(compiled.image)
        host.spawn(host.chart("pong"), name="pong")

        def receive(writer, notification):
            if not isinstance(notification, dict) or not isinstance(notification.get("params"), dict):
                return
            method, params = notification.get("method"), notification["params"]
            if method == "message.send":
                try:
                    host.send(params)  # the message as the other side's transport gave it
                except (tinyactors.TinyactorsError, TypeError, ValueError):
                    # no such actor here, or a message we cannot take: tell the sender
                    writer.write(frame("message.fail", {"sender": params.get("origin"),
                                                        "sendid": params.get("sendid")}))
            elif method == "message.fail":
                sender = params.get("sender")
                address = sender if isinstance(sender, tinyactors.Address) else tinyactors.Address(str(sender))
                if address.system == SYSTEM:   # only a failure of a send of ours
                    host.fail(address, params.get("sendid"))

        async def serve(reader, writer):
            if peer["writer"] is not None:     # one peer: refuse a second connection
                writer.close()
                return
            peer["writer"] = writer
            try:
                while True:
                    (length,) = HEADER.unpack(await reader.readexactly(HEADER.size))
                    if length > MAX_FRAME:
                        break
                    receive(writer, tinyactors.decode(await reader.readexactly(length)))
            except (asyncio.IncompleteReadError, ConnectionError):
                pass
            finally:
                peer["writer"] = None
                writer.close()

        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        emit({"port": server.sockets[0].getsockname()[1]})
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, sys.stdin.buffer.read)   # until the parent closes it
        server.close()
        await host.idle()


if __name__ == "__main__":
    asyncio.run(main())
