#!/usr/bin/env python3
"""
test_text_count.py - Unit tests for text_count module.
"""

import unittest
import os
import textwrap
from text_count import count_file


class TestCountFile(unittest.TestCase):
    """Test cases for the count_file function."""

    def _count_file_test(self, file_content, expected_lines, expected_words, expected_chars):
        """Helper method to test a file with given content."""
        with self.subTest(file_content=file_content,
                           expected_lines=expected_lines,
                           expected_words=expected_words,
                           expected_chars=expected_chars):
            # Create a temporary file
            filepath = '/tmp/test_temp_file.txt'
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(file_content)

            try:
                stats = count_file(filepath)

                self.assertEqual(stats['lines'], expected_lines)
                self.assertEqual(stats['words'], expected_words)
                self.assertEqual(stats['characters'], expected_chars)
            finally:
                # Clean up temporary file
                if os.path.exists(filepath):
                    os.remove(filepath)

    def get_file_bytes(self, file_content):
        """Helper to get actual byte count of file content."""
        with open('/tmp/byte_check.txt', 'wb') as f:
            f.write(file_content.encode('utf-8'))
        filepath = '/tmp/byte_check.txt'
        with open(filepath, 'rb') as f:
            return len(f.read())

    def test_empty_file(self):
        """Test counting an empty file."""
        filepath = '/tmp/empty.txt'
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write("")
        try:
            stats = count_file(filepath)
            self.assertEqual(stats['lines'], 0)
            self.assertEqual(stats['words'], 0)
            self.assertEqual(stats['characters'], 0)
        finally:
            if os.path.exists(filepath):
                os.remove(filepath)

    def test_single_word_file(self):
        """Test a file with just one word."""
        expected_lines = 1
        expected_words = 1
        expected_chars = 5  # "Hello" is 5 characters
        filepath = '/tmp/hello.txt'
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write("Hello")
        try:
            stats = count_file(filepath)
            self.assertEqual(stats['lines'], expected_lines)
            self.assertEqual(stats['words'], expected_words)
            self.assertEqual(stats['characters'], expected_chars)
        finally:
            if os.path.exists(filepath):
                os.remove(filepath)

    def test_multi_line_file(self):
        """Test a multi-line file"""
        content = "Line one with several words.\nLine two.\nLine three."
        expected_lines = 3
        expected_words = 9
        expected_chars = len(content)
        filepath = '/tmp/multiline.txt'
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        try:
            stats = count_file(filepath)
            self.assertEqual(stats['lines'], expected_lines)
            self.assertEqual(stats['words'], expected_words)
            self.assertEqual(stats['characters'], expected_chars)
        finally:
            if os.path.exists(filepath):
                os.remove(filepath)

    def test_special_characters_file(self):
        """Test a file with special characters and emojis.
        
        Content: "Hello, 日本語! Coder. https://example.com 2025-01-15 Emoji: 😀👋"
        This has 7 words when split by whitespace.
        """
        content = "Hello, 日本語! Coder. https://example.com 2025-01-15 Emoji: 😀👋"
        filepath = '/tmp/special.txt'
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        try:
            stats = count_file(filepath)
            self.assertEqual(stats['lines'], 1)
            self.assertEqual(stats['words'], 7)
            self.assertEqual(stats['characters'], len(content))
        finally:
            if os.path.exists(filepath):
                os.remove(filepath)

    def test_file_with_blank_lines(self):
        """Test a file with blank lines (empty line in the middle)."""
        content = "First line\n\nThird line"
        filepath = '/tmp/blanks.txt'
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        try:
            stats = count_file(filepath)
            # Should be 3 lines: first line, blank line, third line
            self.assertEqual(stats['lines'], 3)
            # Split by whitespace gives 4 words: First, line, Third, line
            self.assertEqual(stats['words'], 4)
            self.assertEqual(stats['characters'], len(content))
        finally:
            if os.path.exists(filepath):
                os.remove(filepath)

    def test_whitespace_handling(self):
        """Test file with extra whitespace around words."""
        content = "   hello   world   \n   multiple    spaces   "
        filepath = '/tmp/whitespace.txt'
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        try:
            stats = count_file(filepath)
            self.assertEqual(stats['lines'], 2)
            # Split by whitespace gives 4 words: hello, world, multiple, spaces
            self.assertEqual(stats['words'], 4)
            self.assertEqual(stats['characters'], len(content))
        finally:
            if os.path.exists(filepath):
                os.remove(filepath)

    def test_unicode_only_file(self):
        """Test a file with only unicode characters."""
        content = "你好世界 こんにちは"  # Mixture of Chinese and Japanese
        filepath = '/tmp/unicode.txt'
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        try:
            stats = count_file(filepath)
            self.assertEqual(stats['lines'], 1)
            self.assertEqual(stats['words'], 2)
            self.assertEqual(stats['characters'], len(content))
        finally:
            if os.path.exists(filepath):
                os.remove(filepath)


if __name__ == '__main__':
    unittest.main()
