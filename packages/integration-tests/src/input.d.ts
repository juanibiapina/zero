declare module "input" {
  interface Input {
    text(prompt: string): Promise<string>;
    password(prompt: string): Promise<string>;
    confirm(prompt: string): Promise<boolean>;
  }
  const input: Input;
  export default input;
}
