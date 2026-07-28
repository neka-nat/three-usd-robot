"""Validate USD files with pxr's UsdValidation framework (M16).

Runs every registered pxr validator (incl. the usdPhysics checkers) over each
given file — the closest offline equivalent of Isaac Sim's Asset Validator:

    pip install usd-core
    python scripts/pxr-validate.py out/robot.usda out/robot.usdz
"""

import sys

from pxr import Sdf, Tf, Usd, UsdValidation

if len(sys.argv) < 2:
    print(__doc__)
    sys.exit(2)

registry = UsdValidation.ValidationRegistry()
validators = registry.GetOrLoadAllValidators()
print(f"running {len(validators)} pxr validators")

failed = False
for path in sys.argv[1:]:
    if Sdf.Layer.FindOrOpen(path) is None:
        print(f"[FAIL] {path}: not found / unreadable")
        failed = True
        continue

    mark = Tf.Error.Mark()
    stage = Usd.Stage.Open(path)
    open_errors = [str(e) for e in mark.GetErrors()]

    issues = UsdValidation.ValidationContext(validators).Validate(stage)
    errors = [i for i in issues if i.GetType() == UsdValidation.ValidationErrorType.Error]
    warns = [i for i in issues if i.GetType() != UsdValidation.ValidationErrorType.Error]

    status = "OK" if not errors and not open_errors else "FAIL"
    if status == "FAIL":
        failed = True
    prims = list(stage.Traverse())
    print(f"[{status}] {path}: prims={len(prims)} "
          f"openErrors={len(open_errors)} errors={len(errors)} warnings={len(warns)}")
    for message in open_errors[:5]:
        print("   open:", message)
    for issue in errors[:10]:
        print("   error:", issue.GetValidator().GetMetadata().name, "-", issue.GetMessage())
    for issue in warns[:5]:
        print("   warn:", issue.GetValidator().GetMetadata().name, "-", issue.GetMessage())

sys.exit(1 if failed else 0)
