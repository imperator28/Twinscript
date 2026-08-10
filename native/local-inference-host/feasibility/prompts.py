def hy_mt2_prompt(text: str, target_language: str) -> str:
    return (
        f"Translate the following text into {target_language}. Note that you should only "
        f"output the translated result without any additional explanation: {text}"
    )
