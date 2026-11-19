# risk

Classify the risk of the change with the fixed rule. You do not judge it.

Run, from the repository root:

```bash
python3 "$AIORC_DIR/scripts/classify_risk.py"
```

Hand back its JSON exactly as printed (see the harness scripts skill). The
server routes on `level`: `split` ends the run and asks the developer to
divide the change into smaller pull requests.
