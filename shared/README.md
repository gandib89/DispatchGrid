# Shared contracts

This directory is the server/client contract boundary. It contains the organization schemas
(C04) and job schemas (C05) as runtime-neutral Zod factories: each module exports a function
receiving the caller's `z` instance, so server and client share validation without sharing a
bundler or Prisma dependency.

Shared modules must remain runtime-neutral: no Express request objects, React state, Prisma models,
database clients, or environment-variable reads.
