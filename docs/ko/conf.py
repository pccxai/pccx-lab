import os
import sys
sys.path.insert(0, os.path.abspath('..'))

project = "pccx-lab"
copyright = "2026, hwkim"
author = "hwkim"

language = "ko"
html_baseurl = "https://pccxai.github.io/pccx/ko/lab/"

extensions = [
    "myst_parser",
    "sphinxcontrib.mermaid",
    "sphinx_design",
]

html_theme = "furo"
html_theme_options = {
    "announcement": "Part of the pccx ecosystem — <a href='https://pccxai.github.io/pccx/ko/'>pccx main docs</a>",
}

html_static_path = []
templates_path = []
exclude_patterns = ["_build", "Thumbs.db", ".DS_Store", ".venv"]

myst_enable_extensions = ["colon_fence"]
