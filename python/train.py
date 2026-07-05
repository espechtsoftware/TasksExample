#!/usr/bin/env python3
"""AutoML worker: given a CSV and a target column, pick and fit the best model.

Invoked by the Node MCP server as a child process:

    python3 train.py --config /path/to/config.json

Config JSON:
    csv_path      path to the uploaded dataset
    target_column column to predict
    problem_type  "classification" | "regression" | "auto"
    output_path   where to joblib.dump the fitted pipeline bundle
    random_state  optional int (default 42)

Protocol: one JSON object per stdout line.
    {"event":"progress","stage":"...","message":"..."}   as work proceeds
    {"event":"result","resolved_type":...,"best_model":...,"metrics":{...}}
    {"event":"error","message":"..."}                    on any failure

The Node side turns progress lines into MCP task statusMessage updates and
the result line into the task's final CallToolResult.
"""
import argparse
import json
import sys
import warnings

warnings.filterwarnings("ignore")  # keep stdout parseable: JSON lines only

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.model_selection import cross_validate
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import LabelEncoder, OneHotEncoder, StandardScaler
from xgboost import XGBClassifier, XGBRegressor

MIN_ROWS = 30
MAX_COLUMNS = 500


def emit(payload):
    print(json.dumps(payload), flush=True)


def progress(stage, message):
    emit({"event": "progress", "stage": stage, "message": message})


def fail(message):
    emit({"event": "error", "message": message})
    sys.exit(1)


def infer_problem_type(y: pd.Series) -> str:
    """'auto' resolution: anything non-numeric (strings, booleans,
    categoricals) is classes; low-cardinality integers are classes;
    everything else numeric is a regression target."""
    if not pd.api.types.is_numeric_dtype(y) or pd.api.types.is_bool_dtype(y):
        return "classification"
    if pd.api.types.is_integer_dtype(y) and y.nunique() <= 20:
        return "classification"
    return "regression"


def build_preprocessor(X: pd.DataFrame) -> ColumnTransformer:
    numeric = X.select_dtypes(include=["number", "bool"]).columns.tolist()
    categorical = [c for c in X.columns if c not in numeric]
    return ColumnTransformer(
        [
            (
                "numeric",
                Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())]),
                numeric,
            ),
            (
                "categorical",
                Pipeline(
                    [
                        ("impute", SimpleImputer(strategy="most_frequent")),
                        ("onehot", OneHotEncoder(handle_unknown="ignore", sparse_output=False)),
                    ]
                ),
                categorical,
            ),
        ],
        remainder="drop",
    )


def candidates(problem_type: str, random_state: int, n_classes: int):
    """The model zoo: a linear baseline, a bagged forest, and boosted trees.
    XGBoost usually wins on tabular data but the linear baseline keeps us
    honest — if it ties the ensembles, the extra complexity buys nothing."""
    if problem_type == "classification":
        return {
            "logistic_regression": LogisticRegression(max_iter=2000),
            "random_forest": RandomForestClassifier(n_estimators=300, random_state=random_state),
            "xgboost": XGBClassifier(
                n_estimators=300,
                max_depth=6,
                learning_rate=0.1,
                eval_metric="logloss" if n_classes == 2 else "mlogloss",
                random_state=random_state,
            ),
        }
    return {
        "ridge": Ridge(),
        "random_forest": RandomForestRegressor(n_estimators=300, random_state=random_state),
        "xgboost": XGBRegressor(
            n_estimators=300, max_depth=6, learning_rate=0.1, random_state=random_state
        ),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    with open(args.config) as f:
        config = json.load(f)

    random_state = int(config.get("random_state", 42))
    target = config["target_column"]

    # --- load & validate -----------------------------------------------------
    progress("loading", "Loading and validating dataset")
    try:
        df = pd.read_csv(config["csv_path"])
    except Exception as e:  # noqa: BLE001 - report anything unreadable to the caller
        fail(f"Could not parse CSV: {e}")

    if target not in df.columns:
        fail(f"Target column '{target}' not found. Available: {', '.join(map(str, df.columns[:50]))}")
    if len(df.columns) > MAX_COLUMNS:
        fail(f"Too many columns ({len(df.columns)} > {MAX_COLUMNS})")

    df = df.dropna(subset=[target])
    if len(df) < MIN_ROWS:
        fail(f"Need at least {MIN_ROWS} rows with a non-null target; got {len(df)}")

    y_raw = df[target]
    X = df.drop(columns=[target])
    if X.shape[1] == 0:
        fail("Dataset has no feature columns besides the target")

    # --- resolve problem type --------------------------------------------------
    progress("analyzing", "Analyzing target column")
    requested = config.get("problem_type", "auto")
    resolved = infer_problem_type(y_raw) if requested == "auto" else requested

    label_encoder = None
    if resolved == "classification":
        counts = y_raw.value_counts()
        if len(counts) < 2:
            fail("Classification needs at least 2 classes in the target column")
        if counts.min() < 3:
            fail(f"Every class needs >= 3 examples; rarest class has {counts.min()}")
        label_encoder = LabelEncoder()
        y = label_encoder.fit_transform(y_raw)
        n_classes = len(label_encoder.classes_)
    else:
        if not pd.api.types.is_numeric_dtype(y_raw):
            fail(f"Regression target '{target}' must be numeric")
        y = y_raw.to_numpy()
        n_classes = 0

    progress(
        "analyzing",
        f"Resolved problem type: {resolved} "
        f"({len(df)} rows, {X.shape[1]} features"
        + (f", {n_classes} classes)" if resolved == "classification" else ")"),
    )

    # --- cross-validated model selection ------------------------------------------
    preprocessor = build_preprocessor(X)
    zoo = candidates(resolved, random_state, n_classes)
    cv_folds = max(2, min(5, len(df) // 15))
    if resolved == "classification":
        scoring = {"accuracy": "accuracy", "f1_weighted": "f1_weighted"}
        primary = "f1_weighted"
    else:
        scoring = {"r2": "r2", "neg_rmse": "neg_root_mean_squared_error"}
        primary = "r2"

    leaderboard = {}
    for i, (name, estimator) in enumerate(zoo.items(), start=1):
        progress("training", f"Cross-validating candidate {i}/{len(zoo)}: {name} ({cv_folds}-fold)")
        pipeline = Pipeline([("preprocess", preprocessor), ("model", estimator)])
        try:
            scores = cross_validate(pipeline, X, y, cv=cv_folds, scoring=scoring, n_jobs=1)
        except Exception as e:  # noqa: BLE001 - a failing candidate shouldn't sink the job
            progress("training", f"Candidate {name} failed CV and was skipped: {e}")
            continue
        leaderboard[name] = {
            metric: round(float(np.mean(scores[f"test_{metric}"])), 4) for metric in scoring
        }

    if not leaderboard:
        fail("No candidate model completed cross-validation")

    best_name = max(leaderboard, key=lambda name: leaderboard[name][primary])
    progress("training", f"Best candidate: {best_name} ({primary}={leaderboard[best_name][primary]})")

    # --- final fit on all data + save ------------------------------------------------
    progress("finalizing", f"Fitting {best_name} on the full dataset")
    final_pipeline = Pipeline([("preprocess", build_preprocessor(X)), ("model", zoo[best_name])])
    final_pipeline.fit(X, y)

    bundle = {
        "pipeline": final_pipeline,
        "label_encoder": label_encoder,  # None for regression
        "feature_columns": X.columns.tolist(),
        "target_column": target,
        "problem_type": resolved,
        "best_model": best_name,
        "cv_metrics": leaderboard,
    }
    joblib.dump(bundle, config["output_path"])
    progress("finalizing", "Model artifact saved")

    emit(
        {
            "event": "result",
            "resolved_type": resolved,
            "best_model": best_name,
            "metrics": {
                "primary_metric": primary,
                "cv_folds": cv_folds,
                "rows_used": int(len(df)),
                "feature_count": int(X.shape[1]),
                "leaderboard": leaderboard,
            },
        }
    )


if __name__ == "__main__":
    main()
