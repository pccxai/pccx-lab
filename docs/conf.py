import os
import sys

project = "pccx-lab"
copyright = "2026, hwkim"
author = "hwkim"

language = "en"
html_baseurl = "https://pccxai.github.io/pccx/en/lab/"

extensions = [
    "myst_parser",
    "sphinxcontrib.mermaid",
    "sphinx_design",
]

html_theme = "furo"
html_theme_options = {
    "announcement": "Part of the pccx ecosystem — <a href='https://pccxai.github.io/pccx/en/'>pccx main docs</a>",
}

html_static_path = []
templates_path = []
exclude_patterns = ["_build", "Thumbs.db", ".DS_Store", "ko", ".venv"]

myst_enable_extensions = ["colon_fence"]
