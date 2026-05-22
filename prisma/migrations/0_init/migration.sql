-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('MUSIC', 'VIDEO', 'IMAGE', 'THREE_D');

-- CreateEnum
CREATE TYPE "PinType" AS ENUM ('EVENT', 'BOUNTY', 'EXPERIENCE', 'LAUNCH', 'OTHER', 'LANDMARK');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('LIKE', 'COMMENT', 'SUBSCRIPTION', 'POST', 'SHOP_ASSET', 'FOLLOW', 'REPLY', 'BOUNTY', 'BOUNTY_PARTICIPANT', 'BOUNTY_SUBMISSION', 'BOUNTY_COMMENT', 'BOUNTY_REPLY', 'BOUNTY_WINNER', 'BOUNTY_DOUBT', 'BOUNTY_DOUBT_CREATE', 'BOUNTY_DOUBT_REPLY');

-- CreateEnum
CREATE TYPE "ItemPrivacy" AS ENUM ('DRAFT', 'FOR_SALE', 'NOT_FOR_SALE', 'PUBLIC', 'PRIVATE', 'TIER');

-- CreateEnum
CREATE TYPE "MarketType" AS ENUM ('SONG', 'ADMIN', 'FAN');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'CREATOR');

-- CreateEnum
CREATE TYPE "BountyStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SubmissionViewType" AS ENUM ('UNCHECKED', 'CHECKED', 'ONREVIEW', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Tag" (
    "name" TEXT NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "notificationObjectId" INTEGER NOT NULL,
    "seen" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifierId" TEXT NOT NULL,
    "isCreator" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationObject" (
    "id" SERIAL NOT NULL,
    "entityType" "NotificationType" NOT NULL,
    "entityId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT NOT NULL,
    "isUser" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NotificationObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "features" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "creatorId" TEXT NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Like" (
    "id" SERIAL NOT NULL,
    "postId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Like_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" SERIAL NOT NULL,
    "parentCommentID" INTEGER,
    "postId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User_Asset" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" INTEGER NOT NULL,
    "buyAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Follow" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "followAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Media" (
    "id" SERIAL NOT NULL,
    "url" TEXT NOT NULL,
    "type" "MediaType" NOT NULL,
    "postId" INTEGER NOT NULL,

    CONSTRAINT "Media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorPageAsset" (
    "creatorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "issuerPrivate" TEXT,
    "thumbnail" TEXT,
    "priceUSD" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "limit" INTEGER NOT NULL,

    CONSTRAINT "CreatorPageAsset_pkey" PRIMARY KEY ("creatorId")
);

-- CreateTable
CREATE TABLE "Creator" (
    "id" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profileUrl" TEXT,
    "coverUrl" TEXT,
    "bio" TEXT,
    "name" TEXT NOT NULL,
    "backgroundSVG" TEXT,
    "showSVG" BOOLEAN NOT NULL DEFAULT false,
    "vanityURL" TEXT,
    "storagePub" TEXT NOT NULL,
    "storageSecret" TEXT NOT NULL,
    "aprovalSend" BOOLEAN NOT NULL,
    "approved" BOOLEAN,
    "pageAssetId" INTEGER,
    "customPageAssetCodeIssuer" TEXT,
    "extraFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Creator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VanitySubscription" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3) NOT NULL,
    "lastPaymentAmount" DOUBLE PRECISION NOT NULL,
    "lastPaymentDate" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VanitySubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Post" (
    "id" SERIAL NOT NULL,
    "content" TEXT NOT NULL,
    "heading" TEXT NOT NULL DEFAULT 'Heading',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "creatorId" TEXT NOT NULL,
    "subscriptionId" INTEGER,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "bio" TEXT,
    "coverImage" TEXT,
    "pronouns" TEXT,
    "image" TEXT,
    "emailVerified" TIMESTAMP(3),
    "firstSignUpMethod" TEXT,
    "joinedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "fromAppSignup" BOOLEAN DEFAULT false,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Album" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "coverImgUrl" TEXT NOT NULL,
    "creatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Album_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Song" (
    "id" SERIAL NOT NULL,
    "artist" TEXT NOT NULL,
    "assetId" INTEGER NOT NULL,
    "creatorId" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "priceUSD" DOUBLE PRECISION NOT NULL,
    "albumId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Song_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User_Song" (
    "userId" TEXT NOT NULL,
    "songId" INTEGER NOT NULL,

    CONSTRAINT "User_Song_pkey" PRIMARY KEY ("userId","songId")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "limit" INTEGER,
    "code" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "issuerPrivate" TEXT,
    "mediaType" "MediaType" NOT NULL,
    "mediaUrl" TEXT NOT NULL,
    "thumbnail" TEXT NOT NULL,
    "privacy" "ItemPrivacy" NOT NULL DEFAULT 'PUBLIC',
    "creatorId" TEXT,
    "tierId" INTEGER,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketAsset" (
    "id" SERIAL NOT NULL,
    "privacy" "ItemPrivacy" NOT NULL DEFAULT 'PUBLIC',
    "price" DOUBLE PRECISION NOT NULL,
    "priceUSD" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "type" "MarketType" NOT NULL DEFAULT 'FAN',
    "assetId" INTEGER NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placerId" TEXT,

    CONSTRAINT "MarketAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellPageAsset" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amountToSell" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "priceUSD" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "priceXLM" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isSold" BOOLEAN NOT NULL DEFAULT false,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placerId" TEXT,
    "soldAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellPageAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAsset" (
    "id" SERIAL NOT NULL,
    "description" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "codeIssuer" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "logoUrl" TEXT NOT NULL,
    "logoBlueData" TEXT,
    "color" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "StellarTerm" TEXT,
    "StellarX" TEXT,
    "Litemint" TEXT,
    "adminId" TEXT NOT NULL,

    CONSTRAINT "AdminAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAssetTag" (
    "id" SERIAL NOT NULL,
    "tagName" TEXT NOT NULL,
    "adminAssetId" INTEGER NOT NULL,

    CONSTRAINT "AdminAssetTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Admin" (
    "id" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profileUrl" TEXT,
    "coverUrl" TEXT,
    "bio" TEXT,
    "name" TEXT,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hotspot" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "dropEveryDays" INTEGER NOT NULL,
    "pinDurationDays" INTEGER NOT NULL,
    "hotspotStartDate" TIMESTAMP(3) NOT NULL,
    "hotspotEndDate" TIMESTAMP(3) NOT NULL,
    "autoCollect" BOOLEAN NOT NULL DEFAULT false,
    "multiPin" BOOLEAN NOT NULL DEFAULT false,
    "shape" TEXT NOT NULL,
    "geoJson" JSONB NOT NULL,
    "qstashScheduleId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hotspot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationGroup" (
    "id" TEXT NOT NULL,
    "privacy" "ItemPrivacy" NOT NULL DEFAULT 'PUBLIC',
    "subscriptionId" INTEGER,
    "assetId" INTEGER,
    "pageAsset" BOOLEAN DEFAULT false,
    "creatorId" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "limit" INTEGER NOT NULL DEFAULT 0,
    "remaining" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "approved" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "radius" DOUBLE PRECISION NOT NULL,
    "image" TEXT,
    "link" TEXT,
    "aiUrlDescriptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "multiPin" BOOLEAN NOT NULL DEFAULT false,
    "type" "PinType" NOT NULL DEFAULT 'OTHER',
    "hotspotId" TEXT,

    CONSTRAINT "LocationGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "autoCollect" BOOLEAN NOT NULL,
    "locationGroupId" TEXT,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationConsumer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "redeemCode" TEXT NOT NULL,
    "isRedeemed" BOOLEAN NOT NULL DEFAULT false,
    "redeemedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationConsumer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bounty" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceInUSD" DOUBLE PRECISION NOT NULL,
    "priceInBand" DOUBLE PRECISION NOT NULL,
    "totalWinner" INTEGER NOT NULL,
    "currentWinnerCount" INTEGER NOT NULL DEFAULT 0,
    "priceInXLM" DOUBLE PRECISION,
    "requiredBalance" DOUBLE PRECISION NOT NULL,
    "imageUrls" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "status" "BountyStatus" NOT NULL DEFAULT 'PENDING',
    "creatorId" TEXT NOT NULL,
    "userId" TEXT,

    CONSTRAINT "Bounty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BountyWinner" (
    "id" SERIAL NOT NULL,
    "bountyId" INTEGER NOT NULL,
    "xdr" TEXT,
    "isSwaped" BOOLEAN DEFAULT false,
    "userId" TEXT NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BountyWinner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BountyDoubt" (
    "id" SERIAL NOT NULL,
    "bountyId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BountyDoubt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BountyDoubtMessage" (
    "id" SERIAL NOT NULL,
    "doubtId" INTEGER NOT NULL,
    "senderId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "BountyDoubtMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BountyParticipant" (
    "id" SERIAL NOT NULL,
    "bountyId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BountyParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BountySubmission" (
    "id" SERIAL NOT NULL,
    "bountyId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "SubmissionViewType" NOT NULL DEFAULT 'UNCHECKED',

    CONSTRAINT "BountySubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionAttachment" (
    "id" SERIAL NOT NULL,
    "submissionId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BountyComment" (
    "id" SERIAL NOT NULL,
    "bountyParentCommentID" INTEGER,
    "bountyId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BountyComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redeem" (
    "code" TEXT NOT NULL,
    "totalRedeemable" INTEGER NOT NULL,
    "assetRedeemId" INTEGER NOT NULL,

    CONSTRAINT "Redeem_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "RedeemConsumer" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedeemConsumer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QRItem" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "modelUrl" TEXT NOT NULL,
    "externalLink" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "qrCode" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "creatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QRItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QRDescription" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(50) NOT NULL,
    "content" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "qrItemId" TEXT NOT NULL,

    CONSTRAINT "QRDescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PinAgentChatSession" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PinAgentChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PinAgentChatHistory" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinAgentChatHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationGroupJob" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "total" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "redeemMode" TEXT NOT NULL DEFAULT 'separate',
    "log" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocationGroupJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentJob" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "error" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_name_creatorId_key" ON "Subscription"("name", "creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "Like_postId_userId_key" ON "Like"("postId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_userId_creatorId_key" ON "Follow"("userId", "creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "unique_vanityurl" ON "Creator"("vanityURL");

-- CreateIndex
CREATE INDEX "Creator_bio_name_idx" ON "Creator"("bio", "name");

-- CreateIndex
CREATE UNIQUE INDEX "VanitySubscription_creatorId_key" ON "VanitySubscription"("creatorId");

-- CreateIndex
CREATE INDEX "Post_heading_idx" ON "Post"("heading");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "User_name_key" ON "User"("name");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Song_assetId_key" ON "Song"("assetId");

-- CreateIndex
CREATE INDEX "Asset_name_description_idx" ON "Asset"("name", "description");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_code_issuer_key" ON "Asset"("code", "issuer");

-- CreateIndex
CREATE UNIQUE INDEX "MarketAsset_assetId_placerId_key" ON "MarketAsset"("assetId", "placerId");

-- CreateIndex
CREATE UNIQUE INDEX "SellPageAsset_id_placerId_key" ON "SellPageAsset"("id", "placerId");

-- CreateIndex
CREATE UNIQUE INDEX "LocationConsumer_redeemCode_key" ON "LocationConsumer"("redeemCode");

-- CreateIndex
CREATE INDEX "Bounty_title_description_idx" ON "Bounty"("title", "description");

-- CreateIndex
CREATE UNIQUE INDEX "BountyParticipant_bountyId_userId_key" ON "BountyParticipant"("bountyId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "QRItem_id_creatorId_key" ON "QRItem"("id", "creatorId");

-- CreateIndex
CREATE INDEX "QRDescription_qrItemId_order_idx" ON "QRDescription"("qrItemId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "QRDescription_qrItemId_order_key" ON "QRDescription"("qrItemId", "order");

-- CreateIndex
CREATE INDEX "PinAgentChatSession_creatorId_updatedAt_idx" ON "PinAgentChatSession"("creatorId", "updatedAt");

-- CreateIndex
CREATE INDEX "PinAgentChatHistory_creatorId_createdAt_idx" ON "PinAgentChatHistory"("creatorId", "createdAt");

-- CreateIndex
CREATE INDEX "PinAgentChatHistory_sessionId_createdAt_idx" ON "PinAgentChatHistory"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "LocationGroupJob_creatorId_createdAt_idx" ON "LocationGroupJob"("creatorId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentJob_creatorId_createdAt_idx" ON "AgentJob"("creatorId", "createdAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_notificationObjectId_fkey" FOREIGN KEY ("notificationObjectId") REFERENCES "NotificationObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationObject" ADD CONSTRAINT "NotificationObject_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Like" ADD CONSTRAINT "Like_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Like" ADD CONSTRAINT "Like_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentCommentID_fkey" FOREIGN KEY ("parentCommentID") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User_Asset" ADD CONSTRAINT "User_Asset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User_Asset" ADD CONSTRAINT "User_Asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPageAsset" ADD CONSTRAINT "CreatorPageAsset_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Creator" ADD CONSTRAINT "Creator_id_fkey" FOREIGN KEY ("id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VanitySubscription" ADD CONSTRAINT "VanitySubscription_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Album" ADD CONSTRAINT "Album_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Song" ADD CONSTRAINT "Song_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Song" ADD CONSTRAINT "Song_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Song" ADD CONSTRAINT "Song_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User_Song" ADD CONSTRAINT "User_Song_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User_Song" ADD CONSTRAINT "User_Song_songId_fkey" FOREIGN KEY ("songId") REFERENCES "Song"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketAsset" ADD CONSTRAINT "MarketAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketAsset" ADD CONSTRAINT "MarketAsset_placerId_fkey" FOREIGN KEY ("placerId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellPageAsset" ADD CONSTRAINT "SellPageAsset_placerId_fkey" FOREIGN KEY ("placerId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAsset" ADD CONSTRAINT "AdminAsset_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAssetTag" ADD CONSTRAINT "AdminAssetTag_tagName_fkey" FOREIGN KEY ("tagName") REFERENCES "Tag"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAssetTag" ADD CONSTRAINT "AdminAssetTag_adminAssetId_fkey" FOREIGN KEY ("adminAssetId") REFERENCES "AdminAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Admin" ADD CONSTRAINT "Admin_id_fkey" FOREIGN KEY ("id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hotspot" ADD CONSTRAINT "Hotspot_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationGroup" ADD CONSTRAINT "LocationGroup_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationGroup" ADD CONSTRAINT "LocationGroup_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationGroup" ADD CONSTRAINT "LocationGroup_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationGroup" ADD CONSTRAINT "LocationGroup_hotspotId_fkey" FOREIGN KEY ("hotspotId") REFERENCES "Hotspot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_locationGroupId_fkey" FOREIGN KEY ("locationGroupId") REFERENCES "LocationGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationConsumer" ADD CONSTRAINT "LocationConsumer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationConsumer" ADD CONSTRAINT "LocationConsumer_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bounty" ADD CONSTRAINT "Bounty_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bounty" ADD CONSTRAINT "Bounty_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyWinner" ADD CONSTRAINT "BountyWinner_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyWinner" ADD CONSTRAINT "BountyWinner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyDoubt" ADD CONSTRAINT "BountyDoubt_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyDoubt" ADD CONSTRAINT "BountyDoubt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyDoubtMessage" ADD CONSTRAINT "BountyDoubtMessage_doubtId_fkey" FOREIGN KEY ("doubtId") REFERENCES "BountyDoubt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyDoubtMessage" ADD CONSTRAINT "BountyDoubtMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyParticipant" ADD CONSTRAINT "BountyParticipant_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyParticipant" ADD CONSTRAINT "BountyParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountySubmission" ADD CONSTRAINT "BountySubmission_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountySubmission" ADD CONSTRAINT "BountySubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAttachment" ADD CONSTRAINT "SubmissionAttachment_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "BountySubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyComment" ADD CONSTRAINT "BountyComment_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyComment" ADD CONSTRAINT "BountyComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyComment" ADD CONSTRAINT "BountyComment_bountyParentCommentID_fkey" FOREIGN KEY ("bountyParentCommentID") REFERENCES "BountyComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redeem" ADD CONSTRAINT "Redeem_assetRedeemId_fkey" FOREIGN KEY ("assetRedeemId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedeemConsumer" ADD CONSTRAINT "RedeemConsumer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedeemConsumer" ADD CONSTRAINT "RedeemConsumer_code_fkey" FOREIGN KEY ("code") REFERENCES "Redeem"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QRItem" ADD CONSTRAINT "QRItem_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QRDescription" ADD CONSTRAINT "QRDescription_qrItemId_fkey" FOREIGN KEY ("qrItemId") REFERENCES "QRItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PinAgentChatSession" ADD CONSTRAINT "PinAgentChatSession_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PinAgentChatHistory" ADD CONSTRAINT "PinAgentChatHistory_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PinAgentChatHistory" ADD CONSTRAINT "PinAgentChatHistory_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PinAgentChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationGroupJob" ADD CONSTRAINT "LocationGroupJob_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentJob" ADD CONSTRAINT "AgentJob_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
