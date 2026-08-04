"""Browser-side glue between Adafruit Blinka and the webblinka page.

Nothing in here patches or wraps Blinka -- it runs stock, straight from PyPI.
The only thing that had to be written is the `hid` module one directory up,
which re-implements the slice of hidapi that Blinka's MCP2221 driver uses on top
of WebHID.
"""

__all__ = ["rpc", "session"]
