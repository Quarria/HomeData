import argon2, { type HashOptions } from "argon2";

const ARGON2ID_OPTIONS: HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = (password: string) =>
  argon2.hash(password, ARGON2ID_OPTIONS);

export const verifyPassword = (hash: string, password: string) =>
  argon2.verify(hash, password);
