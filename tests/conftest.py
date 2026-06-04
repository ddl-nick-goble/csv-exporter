"""Pytest config for the backend.

We import app.py once at session scope; the module is light (no upstream
calls happen until a handler runs) so this is safe.
"""
import os
import sys

# Make the project root importable.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
