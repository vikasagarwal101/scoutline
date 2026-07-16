/**
 * Image and video processing utilities for Scoutline
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FileError, ValidationError } from "./errors.js";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".avi", ".webm", ".wmv"];
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_VIDEO_SIZE = 8 * 1024 * 1024; // 8MB

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
};

export function isUrl(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

export function validateImageSource(source: string): void {
  if (isUrl(source)) {
    return; // URLs are validated by the API
  }

  const resolvedPath = path.resolve(source);

  if (!fs.existsSync(resolvedPath)) {
    throw new FileError(`File not found: ${source}`, "Check the file path is correct");
  }

  const stats = fs.statSync(resolvedPath);
  if (stats.size > MAX_IMAGE_SIZE) {
    throw new ValidationError(
      `Image exceeds 5MB limit (${(stats.size / 1024 / 1024).toFixed(2)}MB)`,
    );
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext)) {
    throw new ValidationError(
      `Unsupported image format: ${ext}. Supported: ${IMAGE_EXTENSIONS.join(", ")}`,
    );
  }
}

export function validateVideoSource(source: string): void {
  if (isUrl(source)) {
    return; // URLs are validated by the API
  }

  const resolvedPath = path.resolve(source);

  if (!fs.existsSync(resolvedPath)) {
    throw new FileError(`File not found: ${source}`, "Check the file path is correct");
  }

  const stats = fs.statSync(resolvedPath);
  if (stats.size > MAX_VIDEO_SIZE) {
    throw new ValidationError(
      `Video exceeds 8MB limit (${(stats.size / 1024 / 1024).toFixed(2)}MB)`,
    );
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(ext)) {
    throw new ValidationError(
      `Unsupported video format: ${ext}. Supported: ${VIDEO_EXTENSIONS.join(", ")}`,
    );
  }
}

export function encodeImageToBase64(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  const ext = path.extname(resolvedPath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || "image/png";
  const buffer = fs.readFileSync(resolvedPath);
  const base64 = buffer.toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

export function encodeVideoToBase64(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  const ext = path.extname(resolvedPath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || "video/mp4";
  const buffer = fs.readFileSync(resolvedPath);
  const base64 = buffer.toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

export function processImageSource(source: string): string {
  if (isUrl(source)) {
    return source;
  }
  validateImageSource(source);
  return encodeImageToBase64(source);
}

export function processVideoSource(source: string): string {
  if (isUrl(source)) {
    return source;
  }
  validateVideoSource(source);
  return encodeVideoToBase64(source);
}

export function resolveImageSource(source: string): string {
  if (isUrl(source)) {
    return source;
  }
  validateImageSource(source);
  return path.resolve(source);
}

export function resolveVideoSource(source: string): string {
  if (isUrl(source)) {
    return source;
  }
  validateVideoSource(source);
  return path.resolve(source);
}
