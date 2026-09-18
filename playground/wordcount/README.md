# Text Counter

A simple Python command-line utility that counts lines, words, and characters in a text file.

## Installation

No installation required! Just use Python 3.6 or higher.

## Usage

### Command Line

```bash
# Count a single file
python text_count.py myfile.txt

# Use as a module (requires file argument)
python -m text_counter myfile.txt
```

### Output Example
```
File: myfile.txt
Lines: 10
Words: 150
Characters: 850
```

### Programmatic Use

```python
from text_count import count_file

stats = count_file("myfile.txt")
print(f"Words: {stats['words']}")
print(f"Characters: {stats['characters']}")
print(f"Lines: {stats['lines']}")
```

## Features

- 📝 Counts lines (including blank lines)
- 📚 Counts words (splits on whitespace)
- 🔢 Counts characters (including spaces)
- 🌐 Handles Unicode and special characters correctly
- 🧪 Includes comprehensive unit tests

## Testing

Run the unit tests with:

```bash
python -m unittest test_text_count.py
# or
pytest test_text_count.py
```

## License

MIT License - feel free to use this in your projects!
