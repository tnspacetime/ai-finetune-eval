#!/usr/bin/env python3
"""
text_count.py - A simple command-line tool to count lines, words, and characters in a text file.

Usage:
    python text_count.py <file.txt>
    python -m text_counter <file.txt>

Or import in code:
    from text_count import count_stats
    stats = count_stats("myfile.txt")
"""

import sys
import argparse


def count_file(filepath):
    """
    Count lines, words, and characters in a file.

    Args:
        filepath: Path to the text file.

    Returns:
        dict with 'lines', 'words', and 'characters' keys.
    """
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    if content == "":
        return {'lines': 0, 'words': 0, 'characters': 0}

    # Count lines: newline count plus 1 for the final line (if it doesn't end with newline)
    line_count = content.count('\n')
    if not content.endswith('\n'):
        line_count += 1

    # Count characters (including unicode)
    char_count = len(content)

    # Count words: split by whitespace and filter out empty strings
    words = content.split()
    word_count = len(words)

    return {
        'lines': line_count,
        'words': word_count,
        'characters': char_count
    }


def main():
    parser = argparse.ArgumentParser(
        description='Count lines, words, and characters in a text file.'
    )
    parser.add_argument('file', help='Path to the text file to analyze')

    args = parser.parse_args()

    stats = count_file(args.file)

    print(f"File: {args.file}")
    print(f"Lines: {stats['lines']}")
    print(f"Words: {stats['words']}")
    print(f"Characters: {stats['characters']}")


if __name__ == '__main__':
    main()
