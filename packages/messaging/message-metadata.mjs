/** Public owner-list metadata never contains internal history storage references. */
export function publicMessageMetadata({bytes,blobRef,presentation,presentationBytes,postbacks,...record}){
 return {...record,...presentation?{presentation:{revision:presentation.revision,history:(presentation.history||[]).map(({revision,createdAt,mimeType,digest,size,disposition,location,formDigest,toast,statusCode})=>({revision,createdAt,...mimeType?{mimeType}:{},digest,size,disposition,...toast?{toast}:{},...statusCode?{statusCode}:{},...location?{location}:{},...formDigest?{formDigest}:{},authority:'owner-local-result'}))}}:{}};
}
