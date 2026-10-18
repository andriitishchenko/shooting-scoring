#!/usr/bin/env python3
"""
Backend Syntax Checker and Common Issues Finder
Run this to check for common errors without requiring dependencies
"""

import ast
import sys
import os
from pathlib import Path

def check_syntax(filepath):
    """Check Python file syntax"""
    try:
        with open(filepath, 'r') as f:
            code = f.read()
        ast.parse(code)
        return True, None
    except SyntaxError as e:
        return False, f"Syntax error at line {e.lineno}: {e.msg}"
    except Exception as e:
        return False, str(e)

def check_imports(filepath):
    """Check for import issues"""
    issues = []
    try:
        with open(filepath, 'r') as f:
            lines = f.readlines()
        
        for i, line in enumerate(lines, 1):
            line = line.strip()
            # Check for relative imports without proper package structure
            if line.startswith('from .') or line.startswith('import .'):
                if '__init__.py' not in str(filepath):
                    issues.append(f"Line {i}: Relative import in non-package file")
    except Exception as e:
        issues.append(f"Error reading file: {e}")
    
    return issues

def check_common_issues(filepath):
    """Check for common Python issues"""
    issues = []
    try:
        with open(filepath, 'r') as f:
            content = f.read()
            lines = content.split('\n')
        
        # Check for async/await issues
        if 'async def' in content and 'await' not in content:
            issues.append("Warning: async function without await")
        
        # Check for database connection issues
        if 'aiosqlite.connect' in content:
            if 'await db.commit()' not in content and 'INSERT' in content.upper():
                issues.append("Warning: Database insert without commit")
        
        # Check for missing error handling in critical operations
        if 'async with' in content and 'try:' not in content:
            issues.append("Info: Consider adding error handling for async operations")
            
    except Exception as e:
        issues.append(f"Error checking file: {e}")
    
    return issues

def main():
    print("=" * 60)
    print("Backend Syntax & Common Issues Checker")
    print("=" * 60)
    print()
    
    backend_dir = Path(__file__).parent
    python_files = list(backend_dir.rglob("*.py"))
    
    # Exclude venv and tests
    python_files = [f for f in python_files if 'venv' not in str(f) and 'test_' not in f.name]
    
    total_files = len(python_files)
    passed = 0
    failed = 0
    warnings = 0
    
    for filepath in sorted(python_files):
        rel_path = filepath.relative_to(backend_dir)
        print(f"Checking {rel_path}...")
        
        # Syntax check
        syntax_ok, error = check_syntax(filepath)
        if not syntax_ok:
            print(f"  ✗ SYNTAX ERROR: {error}")
            failed += 1
            continue
        
        # Import check
        import_issues = check_imports(filepath)
        if import_issues:
            for issue in import_issues:
                print(f"  ⚠ {issue}")
            warnings += len(import_issues)
        
        # Common issues check
        common_issues = check_common_issues(filepath)
        if common_issues:
            for issue in common_issues:
                print(f"  ℹ {issue}")
        
        if not import_issues and not common_issues:
            print(f"  ✓ OK")
        
        passed += 1
    
    print()
    print("=" * 60)
    print(f"Summary: {total_files} files checked")
    print(f"  ✓ Passed: {passed}")
    print(f"  ✗ Failed: {failed}")
    print(f"  ⚠ Warnings: {warnings}")
    print("=" * 60)
    
    if failed > 0:
        print("\n❌ Some files have ERRORS - fix them before running!")
        return 1
    elif warnings > 0:
        print("\n⚠️  Some files have WARNINGS - review recommended")
        return 0
    else:
        print("\n✅ All files look good!")
        return 0

if __name__ == "__main__":
    sys.exit(main())
