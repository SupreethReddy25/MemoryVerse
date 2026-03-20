import mongoose, { Schema, Document } from 'mongoose';

export interface IDocument extends Document {
  tenantId: string;
  originalFilename: string;
  fileType: 'whatsapp' | 'pdf' | 'calendar';
  chunkCount: number;
  status: 'processing' | 'ready' | 'error';
  pineconeNamespace: string;
  createdAt: Date;
  updatedAt: Date;
}

const documentSchema = new Schema<IDocument>(
  {
    tenantId: {
      type: String,
      required: true,
      index: true,
    },
    originalFilename: {
      type: String,
      required: true,
    },
    fileType: {
      type: String,
      required: true,
      enum: ['whatsapp', 'pdf', 'calendar'],
    },
    chunkCount: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      required: true,
      enum: ['processing', 'ready', 'error'],
      default: 'processing',
    },
    pineconeNamespace: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

export const DocumentModel = mongoose.model<IDocument>('Document', documentSchema, 'documents');
