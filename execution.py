"""Locate the complete Python statement containing the editor's cursor line."""
import ast
import codeop
import io
import tokenize


def statement_at(source, line):
    if not isinstance(source, str) or len(source.encode("utf-8")) > 1024 * 1024:
        raise ValueError("代码必须是文本，且不能超过 1 MB")
    lines = source.split("\n")
    if type(line) is not int or not 1 <= line <= len(lines):
        raise ValueError("无效的光标行号")

    def result(start, end):
        text = "\n".join(lines[start - 1:end])
        try:
            complete = codeop.compile_command(text, symbol="exec") is not None
        except (SyntaxError, ValueError, OverflowError):
            complete = True  # Execution will report the actual syntax error.
        return {"source": text, "start_line": start, "end_line": end,
                "mode": "selection" if end > start and complete else "line"}

    # Root statements include the required indentation/decorator context.
    try:
        module = ast.parse(source)
    except (SyntaxError, ValueError):
        module = None
    if module is not None:
        for node in module.body:
            start = min([node.lineno, *[decorator.lineno for decorator in getattr(node, "decorator_list", [])]])
            if start <= line <= node.end_lineno:
                return result(start, node.end_lineno)
        return result(line, line)

    # Keep suites and decorators together even when another statement is unfinished.
    # Only a new top-level logical statement starts a separate executable region.
    spans = []
    start = end = None
    indent = 0
    logical_start = True
    decorated = False
    try:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.INDENT:
                indent += 1
                continue
            if token.type == tokenize.DEDENT:
                indent -= 1
                continue
            if token.type in (tokenize.ENCODING, tokenize.COMMENT, tokenize.NL, tokenize.ENDMARKER):
                continue
            if token.type == tokenize.NEWLINE:
                logical_start = True
                continue
            if logical_start and indent == 0:
                continuation = decorated or token.string in ("elif", "else", "except", "finally")
                if start is not None and not continuation:
                    spans.append((start, end))
                    start = None
                decorated = token.string == "@" or decorated and token.string not in ("def", "class", "async")
            if start is None:
                start = token.start[0]
            end = token.end[0]
            logical_start = False
    except (tokenize.TokenError, IndentationError, SyntaxError):
        pass
    if start is not None:
        try:
            if codeop.compile_command("\n".join(lines[start - 1:end]), symbol="exec") is None:
                end = len(lines)
        except (SyntaxError, ValueError, OverflowError):
            pass
        spans.append((start, end))
    for start, end in spans:
        if start <= line <= end:
            return result(start, end)
    return result(line, line)
